/**
 * R2-T14 (§5.5): sub-agent rows, Stop = `ai.cancel` of the parent run
 * (never `handle.stop`), Open → `onOpenSubagent`. R2-T15 (§5.6): busy line
 * labels, run marker duration and steps, outcome records at their anchor
 * for a pre-output cancellation and a message-free failure after reload,
 * notices deduplicated. R2-T21 (§8.5) rendered: rejections show their text.
 */
import { implement } from "@orpc/server";
import type { StreamChunk } from "@tanstack/ai";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMemoryTransport } from "#renderer/data/transport/memory";
import { contract } from "#shared/contract";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { hostActionsFor } from "../runtime/host-actions";
import { emptyThreadState } from "../store/thread-store";
import { renderRelay, renderScenario } from "../testing";
import { busyLabel } from "./status/status";

let current: { cleanup(): Promise<void> } | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
});

const t = (key: string, values?: Record<string, unknown>) =>
  `${key}${values != null ? JSON.stringify(values) : ""}`;

describe("R2-T15 status", () => {
  it("busy line labels", () => {
    const state = emptyThreadState();
    expect(busyLabel(t, { state, running: ["Run npm test"], agents: 0 })).toBe(
      "Run npm test"
    );
    expect(busyLabel(t, { state, running: ["a", "b"], agents: 0 })).toBe(
      'chat.busy.tools{"count":2}'
    );
    expect(busyLabel(t, { state, running: [], agents: 3 })).toBe(
      'chat.busy.agents{"count":3}'
    );
    expect(
      busyLabel(t, {
        state: {
          ...state,
          activity: {
            ...state.activity,
            retry: {
              attempt: 2,
              maxAttempts: 5,
              delayMs: 1,
              isNetworkError: false,
            },
          },
        },
        running: [],
        agents: 0,
      })
    ).toBe('chat.busy.retrying{"attempt":2,"max":5}');
    expect(
      busyLabel(t, {
        state: {
          ...state,
          permissions: { items: [{} as never], answering: {} },
        },
        running: [],
        agents: 0,
      })
    ).toBe("chat.busy.needsYou");
    expect(busyLabel(t, { state, running: [], agents: 0 })).toBe(
      "chat.busy.working"
    );
  });

  it("run marker: duration and steps (sessions)", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1", { timestamp: 1_000 }),
      ...b.text("u1", "user", "go"),
      b.textStart("a1"),
      ...b.toolCall("c1", "read", "a1", { path: "a" }),
      b.toolResult("c1", { text: "x" }),
      ...b.toolCall("c2", "read", "a1", { path: "b" }),
      b.toolResult("c2", { text: "y" }),
      b.textEnd("a1"),
      b.runFinished("r1", "success", { timestamp: 49_000 }),
    ]);
    current = await renderRelay(relay, "session");
    expect(await screen.findByText("Done in 48.0s, 2 steps")).toBeTruthy();
  });

  it("outcomes at their anchors after reload: cancelled before output, failure with no message", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1"),
      ...b.text("u1", "user", "first"),
      b.runFinished("r1", "cancelled"),
      b.runStarted("r2"),
      ...b.text("u2", "user", "second"),
      ...b.text("r2:error", "assistant", ""),
      b.runError("r2", { message: "The model provider had a problem (400)." }),
    ]);
    current = await renderRelay(relay, "session");
    expect(await screen.findByText("Stopped")).toBeTruthy();
    expect(
      screen.getByText("The model provider had a problem (400).")
    ).toBeTruthy();
    const log = screen.getByRole("log");
    const order = [
      ...log.querySelectorAll(
        "[data-message-id], [data-slot=run-marker], [data-slot=error-card]"
      ),
    ].map(
      (node) =>
        node.getAttribute("data-message-id") ?? node.getAttribute("data-slot")
    );
    expect(order.indexOf("run-marker")).toBeGreaterThan(order.indexOf("u1"));
    expect(order.indexOf("error-card")).toBeGreaterThan(order.indexOf("u2"));
  });

  it("notices are deduplicated by key", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.custom("agent.notification", {
        severity: "info",
        message: "one",
        notificationKey: "k",
      }),
      b.custom("agent.notification", {
        severity: "info",
        message: "two",
        notificationKey: "k",
      }),
    ]);
    current = await renderRelay(relay, "session");
    expect(await screen.findByText("two")).toBeTruthy();
    expect(screen.queryByText("one")).toBeNull();
  });
});

describe("abacus.notice (main's own history notice)", () => {
  it("renders the too-large history notice from the snapshot, and reveals its path through system.showItemInFolder", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.custom("abacus.notice", {
        kind: "too-large",
        size: 600 * 1024 ** 2,
        limit: 512 * 1024 ** 2,
        notificationKey: "abacus.history",
        path: "/home/.abacusai-bot/transcripts/t-1.json",
      }),
    ]);
    const show = vi.fn();
    const impl = implement(contract);
    const transport = createMemoryTransport(
      {
        system: {
          showItemInFolder: impl.system.showItemInFolder.handler(
            ({ input }) => {
              show(input);
            }
          ),
        },
      },
      {}
    );
    const rendered = await renderRelay(
      relay,
      "session",
      {},
      {},
      hostActionsFor(transport)
    );
    current = {
      cleanup: async () => {
        await rendered.cleanup();
        await transport.close();
      },
    };
    expect(
      await screen.findByText(
        "Earlier history is too large to show here (600 MB, the limit is 512 MB)."
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    await waitFor(() =>
      expect(show).toHaveBeenCalledExactlyOnceWith({
        path: "/home/.abacusai-bot/transcripts/t-1.json",
      })
    );
  });
});

describe("R2-T14 sub-agents", () => {
  it("Stop cancels the parent run; Open opens the agent", async () => {
    const onOpenSubagent = vi.fn();
    const rendered = await renderScenario("session-subagents", {
      onOpenSubagent,
    });
    current = rendered;
    const rows = await waitFor(() => {
      const found = document.querySelectorAll<HTMLElement>(
        '[data-slot="subagent-row"]'
      );
      expect(found).toHaveLength(3);
      return found;
    });
    fireEvent.click(
      within(rows[0]!).getByRole("button", { name: "Open agent" })
    );
    expect(onOpenSubagent).toHaveBeenCalledWith("sub-1");
    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(rendered.fixture.relay.stats.cancel).toEqual([{ runId: "r1" }])
    );
  });
});

describe("R2-T21 queue (rendered)", () => {
  it("a drained entry's edit shows it already went out; a respawn's shows the restart", async () => {
    const relay = new FakeRelay();
    relay.emitAll([
      ...b.sessionReady(),
      b.runStarted("r1"),
      ...b.text("u1", "user", "go"),
      b.custom("queue.updated", {
        messages: [{ id: "q-1", message: "later", waitingFor: "turn" }],
        dequeued: null,
      }),
    ]);
    current = await renderRelay(relay, "session");
    await screen.findByText("later");
    relay.emit(
      b.custom("queue.command_rejected", {
        incarnation: "inc-1",
        entryId: "q-1",
        command: "update",
        reason: "not_found",
      }) as StreamChunk
    );
    expect(
      await screen.findByText("That message already went out")
    ).toBeTruthy();
    relay.emit(
      b.custom("queue.command_rejected", {
        incarnation: "inc-1",
        entryId: "q-1",
        command: "update",
        reason: "incarnation",
      })
    );
    expect(
      await screen.findByText("The agent restarted, so the queue changed")
    ).toBeTruthy();
  });
});

it("read-only bot chats hide retry and named model switches", async () => {
  const relay = new FakeRelay();
  relay.emitAll([
    ...b.sessionReady(),
    b.runStarted("dead"),
    ...b.text("ask", "user", "go"),
    b.runError("dead", {
      message: "Turn failed",
      actions: [
        { type: "retry" },
        {
          type: "switch-model",
          model: "abacus/openllm",
          label: "RouteLLM - Open",
        },
      ],
    }),
  ]);
  current = await renderRelay(relay, "bot", {
    readOnly: { reason: "Read only" },
    model: { value: "a", label: "A", onChange: vi.fn(), groups: [] },
  });
  await screen.findByText("Turn failed");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(screen.queryByRole("button", { name: /Continue on/ })).toBeNull();
  expect(relay.stats.send).toHaveLength(0);
});

it("re-runs a bot's hidden first turn when there is no visible user message", async () => {
  const relay = new FakeRelay();
  relay.emitAll([
    ...b.sessionReady(),
    b.runStarted("first-run"),
    b.runError("first-run", { message: "The provider stopped" }),
  ]);
  current = await renderRelay(relay, "bot");
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await waitFor(() => expect(relay.stats.send).toHaveLength(1));
  expect(relay.stats.send[0]!.messages.at(-1)).toMatchObject({
    role: "user",
    parts: [{ type: "text", content: "Continue from where you left off" }],
  });
});
