import { contract } from "@abacus-ai/contract/contract";
import type { ConnectorsEvent } from "@abacus-ai/contract/contract/connectors";
import type {
  ConnectorOutcome,
  ConnectorRequest,
} from "@abacus-ai/contract/contracts";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
/**
 * R3-T32 (jsdom, memory transport): the card shows the snapshot's pending
 * asks for this conversation only; `request`/`cleared` update it; Connect →
 * `connectors.connect`, then `mcp.refresh` for the requesting session, then
 * `respond {connected}` (review r2 #5); a refresh failure shows the error
 * and answers nothing; `success: false` (no agent running) proceeds; a field
 * flow uses `submitFields`; a cancelled flow answers `declined`; Decline
 * answers `declined`; asks of another conversation are counted for that
 * conversation's attention; a reopened iterator re-snapshots.
 */
import { implement } from "@orpc/server";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createMemoryTransport } from "#renderer/data/transport/memory";

import {
  connectRequest,
  reduceRequests,
  useConnectorRequests,
  usePendingConnectorAsks,
} from "./connector-requests";

const MINE = sessionConversationKey("ws-1", "s-1");
const OTHER = sessionConversationKey("ws-1", "s-2");

const ask = (requestId: string, key: string = MINE): ConnectorRequest =>
  ({
    requestId,
    connectorId: "github",
    label: "GitHub",
    conversationKey: key,
  }) as ConnectorRequest;

interface Fake {
  calls: string[];
  push(event: ConnectorsEvent): void;
  snapshot: ConnectorRequest[];
  connectOutcome: ConnectorOutcome;
  refresh: () => { success: boolean; error?: string };
  opened: number;
}

const makeFake = (): Fake => ({
  calls: [],
  push: () => {},
  snapshot: [],
  connectOutcome: { ok: true },
  refresh: () => ({ success: true }),
  opened: 0,
});

const impl = implement(contract);

const routerFor = (fake: Fake) => ({
  connectors: {
    events: impl.connectors.events.handler(async function* ({ input }) {
      fake.opened += 1;
      const queue: ConnectorsEvent[] = [];
      let wake: (() => void) | null = null;
      fake.push = (event) => {
        queue.push(event);
        wake?.();
      };
      if (input?.conversationKey != null)
        yield {
          type: "snapshot",
          requests: fake.snapshot.filter(
            (r) => r.conversationKey === input.conversationKey
          ),
        } satisfies ConnectorsEvent;
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }),
    connect: impl.connectors.connect.handler(({ input }) => {
      fake.calls.push(`connect:${input.connectorId}`);
      return fake.connectOutcome;
    }),
    submitFields: impl.connectors.submitFields.handler(({ input }) => {
      fake.calls.push(`submitFields:${JSON.stringify(input.values)}`);
      return fake.connectOutcome;
    }),
    respond: impl.connectors.respond.handler(({ input }) => {
      fake.calls.push(`respond:${input.requestId}:${input.outcome}`);
    }),
    cancelConnect: impl.connectors.cancelConnect.handler(() => {
      fake.calls.push("cancel");
    }),
  },
  mcp: {
    refresh: impl.mcp.refresh.handler(({ input }) => {
      fake.calls.push(`refresh:${input.workspaceId}:${input.sessionId}`);
      const result = fake.refresh();
      if (result.error === "throw") throw new Error("refresh broke");
      return result;
    }),
  },
});

let transport: ReturnType<typeof createMemoryTransport> | null = null;
afterEach(() => {
  transport?.close();
  transport = null;
});

const setup = (fake: Fake) => {
  transport = createMemoryTransport(routerFor(fake) as never, {});
  return transport;
};

describe("reduceRequests", () => {
  it("keeps only this conversation's asks and drops cleared ones", () => {
    let list = reduceRequests(
      [],
      { type: "snapshot", requests: [ask("a"), ask("b", OTHER)] },
      MINE
    );
    expect(list.map((r) => r.requestId)).toEqual(["a"]);
    list = reduceRequests(
      list,
      { type: "request", request: ask("c", OTHER) },
      MINE
    );
    list = reduceRequests(list, { type: "request", request: ask("d") }, MINE);
    list = reduceRequests(list, { type: "request", request: ask("d") }, MINE);
    list = reduceRequests(list, { type: "cleared", requestId: "a" }, MINE);
    expect(list.map((r) => r.requestId)).toEqual(["d"]);
  });
});

describe("useConnectorRequests", () => {
  it("shows the snapshot, then live requests and clears", async () => {
    const fake = makeFake();
    fake.snapshot = [ask("a"), ask("x", OTHER)];
    const t = setup(fake);
    const { result } = renderHook(() => useConnectorRequests(t, MINE));
    await waitFor(() => expect(result.current.current?.requestId).toBe("a"));
    act(() => fake.push({ type: "cleared", requestId: "a" }));
    await waitFor(() => expect(result.current.current).toBeNull());
    act(() => fake.push({ type: "request", request: ask("b") }));
    await waitFor(() => expect(result.current.current?.requestId).toBe("b"));
  });

  it("Connect refreshes the requesting session before answering", async () => {
    const fake = makeFake();
    fake.snapshot = [ask("a")];
    const t = setup(fake);
    const { result } = renderHook(() => useConnectorRequests(t, MINE));
    await waitFor(() => expect(result.current.current).not.toBeNull());
    act(() => result.current.connect());
    await waitFor(() => expect(result.current.current).toBeNull());
    expect(fake.calls).toEqual([
      "connect:github",
      "refresh:ws-1:s-1",
      "respond:a:connected",
    ]);
  });

  it("a refresh failure shows the error and answers nothing", async () => {
    const fake = makeFake();
    fake.snapshot = [ask("a")];
    fake.refresh = () => ({ success: false, error: "throw" });
    const t = setup(fake);
    const { result } = renderHook(() => useConnectorRequests(t, MINE));
    await waitFor(() => expect(result.current.current).not.toBeNull());
    act(() => result.current.connect());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.current?.requestId).toBe("a");
    expect(fake.calls.some((call) => call.startsWith("respond"))).toBe(false);
    act(() => result.current.decline());
    await waitFor(() => expect(fake.calls).toContain("respond:a:declined"));
  });

  it("re-snapshots when the iterator reopens", async () => {
    const fake = makeFake();
    fake.snapshot = [ask("a")];
    const t = setup(fake);
    const { result, rerender } = renderHook(
      ({ key }) => useConnectorRequests(t, key),
      { initialProps: { key: MINE as string } }
    );
    await waitFor(() => expect(result.current.current?.requestId).toBe("a"));
    rerender({ key: OTHER });
    await waitFor(() => expect(result.current.current).toBeNull());
    rerender({ key: MINE });
    await waitFor(() => expect(result.current.current?.requestId).toBe("a"));
    expect(fake.opened).toBe(3);
  });
});

describe("connectRequest", () => {
  it("success: false (no agent running) proceeds to answer", async () => {
    const fake = makeFake();
    fake.refresh = () => ({
      success: false,
      error: "CLI session is not running.",
    });
    const t = setup(fake);
    await expect(connectRequest(t.client, ask("a"))).resolves.toEqual({
      kind: "connected",
    });
    expect(fake.calls.at(-1)).toBe("respond:a:connected");
  });

  it("a reported refresh failure stays actionable", async () => {
    const fake = makeFake();
    fake.refresh = () => ({ success: false, error: "config write failed" });
    const t = setup(fake);
    await expect(connectRequest(t.client, ask("a"))).resolves.toEqual({
      kind: "error",
      message: "config write failed",
    });
    expect(fake.calls.some((call) => call.startsWith("respond"))).toBe(false);
  });
  it("a field flow uses submitFields", async () => {
    const fake = makeFake();
    const t = setup(fake);
    await connectRequest(t.client, ask("a"), { token: "x" });
    expect(fake.calls[0]).toBe('submitFields:{"token":"x"}');
  });

  it("a cancelled flow answers declined; a failed one answers nothing", async () => {
    const fake = makeFake();
    fake.connectOutcome = { ok: false, error: "closed", cancelled: true };
    const t = setup(fake);
    await expect(connectRequest(t.client, ask("a"))).resolves.toEqual({
      kind: "declined",
    });
    expect(fake.calls).toEqual(["connect:github", "respond:a:declined"]);
    fake.calls.length = 0;
    fake.connectOutcome = { ok: false, error: "bad token" };
    await expect(connectRequest(t.client, ask("b"))).resolves.toEqual({
      kind: "error",
      message: "bad token",
    });
    expect(fake.calls).toEqual(["connect:github"]);
  });
});

describe("usePendingConnectorAsks", () => {
  it("counts asks per conversation from the keyless stream", async () => {
    const fake = makeFake();
    const t = setup(fake);
    const { result } = renderHook(() => usePendingConnectorAsks(t));
    await waitFor(() => expect(fake.opened).toBe(1));
    act(() => {
      fake.push({ type: "request", request: ask("a", OTHER) });
      fake.push({ type: "request", request: ask("b", OTHER) });
      fake.push({ type: "request", request: ask("c") });
    });
    await waitFor(() =>
      expect(result.current).toEqual({ [OTHER]: 2, [MINE]: 1 })
    );
    act(() => fake.push({ type: "cleared", requestId: "a" }));
    await waitFor(() =>
      expect(result.current).toEqual({ [OTHER]: 1, [MINE]: 1 })
    );
  });
});
