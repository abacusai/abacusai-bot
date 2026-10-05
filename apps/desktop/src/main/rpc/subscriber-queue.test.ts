import type { TerminalOutputChunk } from "@abacus-ai/contract/contract";
import type { IpcEvent } from "@abacus-ai/contract/contracts";
import {
  conversationKey,
  draftConversationRef,
  type ConversationKey,
} from "@abacus-ai/contract/conversation-scope";
/**
 * A-T9: what may be dropped, and what may not. Events are filtered before
 * they are buffered; each iterator's declared delivery class is the spec's;
 * lossless overflow ends the stream with RESYNC_REQUIRED; terminal output
 * resumes by offset with no gap or duplicate and a sticky exit; actionable
 * streams open on a snapshot of what is pending.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectorGate } from "../services/agent-tools/connector-gate";
import {
  ConversationTerminalRuntimeRegistry,
  type TerminalPty,
} from "../services/conversation/conversation-terminal-runtime-registry";
import { DELIVERY } from "./delivery";
import { MainEventBus } from "./event-bus";
import { browserCoalesceKey } from "./procedures/browser";
import { stream } from "./procedures/impl";
import { terminalChunkSize } from "./procedures/terminal";
import {
  LOSSLESS_ACTIONABLE_MAX_EVENTS,
  SubscriberQueue,
} from "./subscriber-queue";
import {
  connectInProcess,
  fakeDeps,
  type InProcessConnection,
} from "./testing";

const at = new Date(0).toISOString();
const connections: InProcessConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) {
    connection.closeClient();
    connection.closeServer();
  }
});

const connect = (deps: ReturnType<typeof fakeDeps>): InProcessConnection => {
  const connection = connectInProcess(deps);
  connections.push(connection);
  return connection;
};

describe("delivery classes (A-T9)", () => {
  it("declares, per iterator, the class the spec's table gives it", () => {
    expect(DELIVERY).toEqual({
      "terminal.output": "lossless-replayable",
      "terminal.events": "lossless-actionable",
      "browser.events": "lossless-actionable",
      "connectors.events": "lossless-actionable",
      "devices.events": "lossless-actionable",
      "routines.events": "lossless-actionable",
      "ai.subscribe": "lossless-actionable",
      "ai.joinRun": "lossless-actionable",
      "ai.runFinished": "lossless-actionable",
      "ai.attention": "lossless-actionable",
      "devices.stream.chunks": "lossless-actionable",
      "mcp.runtime.events": "coalescing",
      "update.events": "coalescing",
      "notch.events": "coalescing",
      "notch.openCommands": "lossless-actionable",
      "window.events": "coalescing",
      "system.events": "coalescing",
      "settings.events": "coalescing",
      "messaging.events": "coalescing",
      "bots.events": "coalescing",
      "memory.events": "coalescing",
      "localModels.progress": "coalescing",
      "voice.whisper.progress": "coalescing",
      "files.events": "coalescing",
      // Spec 04 §26.4 b: one yield; the rows are gitState's.
      "git.watch": "coalescing",
    });
  });

  it("ends a lossless stream with RESYNC_REQUIRED on overflow, never by dropping", async () => {
    const queue = new SubscriberQueue<number>({
      stream: "connectors.events",
      delivery: "lossless-actionable",
    });
    for (let i = 0; i <= LOSSLESS_ACTIONABLE_MAX_EVENTS; i += 1) queue.push(i);

    await expect(queue.next()).rejects.toMatchObject({
      code: "RESYNC_REQUIRED",
      data: { stream: "connectors.events" },
    });
  });

  it("caps a replayable stream by pending bytes", async () => {
    const queue = new SubscriberQueue<string>({
      stream: "terminal.output",
      delivery: "lossless-replayable",
      sizeOf: (chunk) => chunk.length,
      maxBytes: 10,
    });
    queue.push("12345");
    queue.push("67890");
    await expect(queue.next()).resolves.toEqual({
      done: false,
      value: "12345",
    });
    queue.push("abcdefghijk");

    await expect(queue.next()).rejects.toMatchObject({
      code: "RESYNC_REQUIRED",
    });
  });

  it("keeps only the latest of a coalescing key, and every lossless event", async () => {
    const queue = new SubscriberQueue({
      stream: "browser.events",
      delivery: "lossless-actionable",
      coalesceKey: browserCoalesceKey,
    });
    for (let x = 0; x < 1000; x += 1)
      queue.push({ type: "cursor", action: "move", x, y: 0 });
    queue.push({ type: "permission-cleared", requestId: "a" });
    queue.push({ type: "permission-cleared", requestId: "b" });

    expect(queue.pending).toBe(3);
    await expect(queue.next()).resolves.toMatchObject({
      value: { type: "cursor", x: 999 },
    });
  });

  it("turns an overflow inside a stream into its error, and removes its listener", async () => {
    const bus = new MainEventBus();
    const deps = fakeDeps({ bus });
    const baseline = bus.listenerCount();
    let push: (n: number) => void = () => undefined;
    const iterator = stream<number>({
      path: "connectors.events",
      context: {
        transport: "memory",
        webContentsId: 1,
        windowKind: "main",
        deps,
      },
      signal: undefined,
      attach: (pushEvent) => {
        push = pushEvent;
        return bus.listenChannel("memory", () => undefined);
      },
    });
    const first = iterator.next();
    for (let i = 0; i <= LOSSLESS_ACTIONABLE_MAX_EVENTS + 1; i += 1) push(i);

    await expect(first).rejects.toMatchObject({ code: "RESYNC_REQUIRED" });
    expect(bus.listenerCount()).toBe(baseline);
  });
});

/** A registry whose PTYs the test drives, wired to the bus as ServiceHost does. */
const terminalHarness = (maxScrollbackBytes?: number) => {
  const bus = new MainEventBus();
  const ptys: Array<{
    data: (chunk: string) => void;
    exit: (exitCode: number) => void;
  }> = [];
  const registry = new ConversationTerminalRuntimeRegistry({
    ...(maxScrollbackBytes == null ? {} : { maxScrollbackBytes }),
    createPty: () => {
      let onData: (data: string) => void = () => undefined;
      let onExit: (event: { exitCode: number }) => void = () => undefined;
      const pty: TerminalPty = {
        onData: (callback) => {
          onData = callback as (data: string) => void;
        },
        onExit: (callback) => {
          onExit = callback;
        },
        write: () => undefined,
        resize: () => undefined,
        kill: () => undefined,
      };
      ptys.push({
        data: (chunk) => onData(chunk),
        exit: (exitCode) => onExit({ exitCode }),
      });
      return pty;
    },
    onOutput: (event) =>
      bus.dispatch({
        type: "terminal-output",
        terminalId: event.terminalId,
        conversationKey: event.key as ConversationKey,
        conversation: draftConversationRef("w1"),
        generation: event.generation,
        workspaceId: "w1",
        data: event.data,
        emittedAt: at,
      }),
    onExit: (event) =>
      bus.dispatch({
        type: "terminal-exited",
        terminalId: event.terminalId,
        conversationKey: event.key as ConversationKey,
        conversation: draftConversationRef("w1"),
        generation: event.generation,
        workspaceId: "w1",
        exitCode: event.exitCode,
        signal: event.signal,
        emittedAt: at,
      }),
    // As service-host wires it: bus-only, no legacy event.
    onRetire: (event) =>
      bus.dispatchChannel("terminal-retired", {
        terminalId: event.terminalId,
        conversationKey: event.key,
        generation: event.generation,
        reason: event.reason,
      }),
  });
  const deps = fakeDeps({
    bus,
    serviceHost: {
      terminalOutputState: (request: {
        conversationKey: ConversationKey;
        terminalId?: string;
        generation: number;
        fromOffset?: number;
      }) =>
        registry.outputState(
          request.conversationKey,
          request.generation,
          request.terminalId,
          request.fromOffset
        ),
    },
  });
  const key = conversationKey(draftConversationRef("w1"));
  return { bus, registry, ptys, deps, key };
};

describe("terminal output by offset (A-T9)", () => {
  it("is filtered before it is buffered: a flood elsewhere evicts nothing", async () => {
    const { registry, ptys, deps, key } = terminalHarness();
    const started = await registry.start({
      terminalId: "t1",
      scope: { kind: "draft", workspaceId: "w1" },
      cols: 80,
      rows: 24,
    });
    await registry.start({
      terminalId: "t2",
      scope: { kind: "draft", workspaceId: "w1" },
      cols: 80,
      rows: 24,
    });
    const { client } = connect(deps);

    const output = await client.terminal.output({
      conversationKey: key,
      terminalId: "t1",
      generation: started.generation,
    });
    await expect(output.next()).resolves.toMatchObject({
      value: { type: "snapshot", data: "", offset: 0 },
    });

    // 20,000 chunks for the other terminal, then one for this one.
    for (let i = 0; i < 20_000; i += 1) ptys[1]!.data("x");
    ptys[0]!.data("mine");

    await expect(output.next()).resolves.toMatchObject({
      value: { type: "data", data: "mine", offset: 4 },
    });
    await output.return();
  });

  it("resumes from an offset with no gap and no duplicate", async () => {
    const { registry, ptys, deps, key } = terminalHarness();
    const { generation } = await registry.start({
      terminalId: "t1",
      scope: { kind: "draft", workspaceId: "w1" },
      cols: 80,
      rows: 24,
    });
    const { client } = connect(deps);
    ptys[0]!.data("héllo ");

    const first = await client.terminal.output({
      conversationKey: key,
      terminalId: "t1",
      generation,
    });
    const snapshot = await first.next();
    expect(snapshot.value).toEqual({
      type: "snapshot",
      data: "héllo ",
      from: 0,
      offset: 7,
    });
    ptys[0]!.data("world");
    await expect(first.next()).resolves.toMatchObject({
      value: { type: "data", data: "world", offset: 12 },
    });
    await first.return();

    // Missed while away.
    ptys[0]!.data("!!");

    const resumed = await client.terminal.output({
      conversationKey: key,
      terminalId: "t1",
      generation,
      fromOffset: 12,
    });
    await expect(resumed.next()).resolves.toMatchObject({
      value: { type: "snapshot", data: "!!", from: 12, offset: 14 },
    });
    ptys[0]!.data("?");
    await expect(resumed.next()).resolves.toMatchObject({
      value: { type: "data", data: "?", offset: 15 },
    });
    await resumed.return();
  });

  it("falls back to the whole scrollback when the offset was evicted", async () => {
    const { registry, ptys, deps, key } = terminalHarness(8);
    const { generation } = await registry.start({
      terminalId: "t1",
      scope: { kind: "draft", workspaceId: "w1" },
      cols: 80,
      rows: 24,
    });
    ptys[0]!.data("0123456789");
    ptys[0]!.data("abcdef");
    const { client } = connect(deps);

    const output = await client.terminal.output({
      conversationKey: key,
      terminalId: "t1",
      generation,
      fromOffset: 2,
    });
    await expect(output.next()).resolves.toMatchObject({
      value: { type: "snapshot", data: "89abcdef", from: 8, offset: 16 },
    });
    await output.return();
  });

  it("gives a subscriber that arrives after the exit the output and the exit", async () => {
    const { registry, ptys, deps, key } = terminalHarness();
    const { generation } = await registry.start({
      terminalId: "t1",
      scope: { kind: "draft", workspaceId: "w1" },
      cols: 80,
      rows: 24,
    });
    ptys[0]!.data("bye");
    ptys[0]!.exit(3);
    const { client } = connect(deps);

    const output = await client.terminal.output({
      conversationKey: key,
      terminalId: "t1",
      generation,
    });
    const seen = [];
    for await (const chunk of output) seen.push(chunk);

    expect(seen).toEqual([
      { type: "snapshot", data: "bye", from: 0, offset: 3 },
      { type: "exit", exitCode: 3, signal: null },
    ]);
  });

  it("ends a live subscriber with exactly one exit", async () => {
    const { registry, ptys, deps, key } = terminalHarness();
    const { generation } = await registry.start({
      terminalId: "t1",
      scope: { kind: "draft", workspaceId: "w1" },
      cols: 80,
      rows: 24,
    });
    const { client } = connect(deps);
    const output = await client.terminal.output({
      conversationKey: key,
      terminalId: "t1",
      generation,
    });
    await output.next();

    ptys[0]!.data("a");
    ptys[0]!.exit(0);
    const rest = [];
    for await (const chunk of output) rest.push(chunk);

    expect(rest).toEqual([
      { type: "data", data: "a", offset: 1 },
      { type: "exit", exitCode: 0, signal: null },
    ]);
  });

  describe("a generation that ends without its own exit (impl-r1)", () => {
    const scope = { kind: "draft" as const, workspaceId: "w1" };

    const openLive = async (harness: ReturnType<typeof terminalHarness>) => {
      const { generation } = await harness.registry.start({
        terminalId: "t1",
        scope,
        cols: 80,
        rows: 24,
      });
      const baseline = harness.bus.listenerCount();
      const { client } = connect(harness.deps);
      const output = await client.terminal.output({
        conversationKey: harness.key,
        terminalId: "t1",
        generation,
      });
      await output.next(); // snapshot
      return { client, output, generation, baseline };
    };

    const drain = async (
      output: AsyncIterable<unknown>
    ): Promise<unknown[]> => {
      const rest: unknown[] = [];
      for await (const chunk of output) rest.push(chunk);
      return rest;
    };

    for (const [name, retire] of [
      [
        "an explicit close",
        (h: ReturnType<typeof terminalHarness>, generation: number) =>
          h.registry.close(h.key, generation, "t1"),
      ],
      [
        "its scope being disposed",
        (h: ReturnType<typeof terminalHarness>) =>
          h.registry.disposeScope(h.key),
      ],
      [
        "its workspace being disposed",
        (h: ReturnType<typeof terminalHarness>) =>
          h.registry.disposeWorkspace("w1"),
      ],
      [
        "every terminal being disposed",
        (h: ReturnType<typeof terminalHarness>) => h.registry.disposeAll(),
      ],
    ] as const) {
      it(`ends a live reader with retired: closed on ${name}`, async () => {
        const harness = terminalHarness();
        const { output, generation, baseline } = await openLive(harness);
        const listening = harness.bus.listenerCount();
        expect(listening).toBeGreaterThan(baseline);

        harness.ptys[0]!.data("x");
        retire(harness, generation);
        // The suppressed PTY exit must not produce a second ending.
        harness.ptys[0]!.exit(0);

        expect(await drain(output)).toEqual([
          { type: "data", data: "x", offset: 1 },
          { type: "retired", reason: "closed" },
        ]);
        await vi.waitFor(() =>
          expect(harness.bus.listenerCount()).toBe(baseline)
        );
      });
    }

    it("ends a draft reader with retired: superseded when promoted", async () => {
      const harness = terminalHarness();
      const { output, baseline } = await openLive(harness);

      const promoted = await harness.registry.promoteDraftToSession(scope, {
        kind: "session",
        workspaceId: "w1",
        sessionId: "s1",
      });
      expect(promoted.status).toBe("promoted");

      expect(await drain(output)).toEqual([
        { type: "retired", reason: "superseded" },
      ]);
      await vi.waitFor(() =>
        expect(harness.bus.listenerCount()).toBe(baseline)
      );
    });

    it("gives a reader that arrives after a close the output and the retirement", async () => {
      const harness = terminalHarness();
      const { generation } = await harness.registry.start({
        terminalId: "t1",
        scope,
        cols: 80,
        rows: 24,
      });
      harness.ptys[0]!.data("bye");
      harness.registry.close(harness.key, generation, "t1");

      const { client } = connect(harness.deps);
      const output = await client.terminal.output({
        conversationKey: harness.key,
        terminalId: "t1",
        generation,
      });
      expect(await drain(output)).toEqual([
        { type: "snapshot", data: "bye", from: 0, offset: 3 },
        { type: "retired", reason: "closed" },
      ]);
    });

    it("keeps the retired draft's output frozen while the promoted shell writes on", async () => {
      const harness = terminalHarness();
      const { generation } = await harness.registry.start({
        terminalId: "t1",
        scope,
        cols: 80,
        rows: 24,
      });
      harness.ptys[0]!.data("draft");
      await harness.registry.promoteDraftToSession(scope, {
        kind: "session",
        workspaceId: "w1",
        sessionId: "s1",
      });
      harness.ptys[0]!.data("-session");

      expect(
        harness.registry.outputState(harness.key, generation, "t1")
      ).toMatchObject({ data: "draft", retired: "superseded", exit: null });
    });
  });

  it("caps pending terminal output by UTF-8 bytes, not UTF-16 units", async () => {
    const euros = "\u20ac\u20ac\u20ac";
    // Three 3-byte characters: 3 UTF-16 units but 9 bytes.
    expect(terminalChunkSize({ type: "data", data: euros, offset: 9 })).toBe(9);
    expect(terminalChunkSize({ type: "exit", exitCode: 0, signal: null })).toBe(
      0
    );
    const queue = new SubscriberQueue<TerminalOutputChunk>({
      stream: "terminal.output",
      delivery: "lossless-replayable",
      sizeOf: terminalChunkSize,
      maxBytes: 8,
    });
    queue.push({ type: "data", data: euros, offset: 9 });
    await expect(queue.next()).rejects.toMatchObject({
      code: "RESYNC_REQUIRED",
    });
  });

  it("is NOT_FOUND for a terminal main never ran", async () => {
    const { deps, key } = terminalHarness();
    const { client } = connect(deps);

    const output = await client.terminal.output({
      conversationKey: key,
      terminalId: "nope",
      generation: 1,
    });
    await expect(output.next()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("actionable streams open on what is pending (A-T9)", () => {
  const key = conversationKey(draftConversationRef("w1"));

  it("browser.events snapshots the conversation's permission asks", async () => {
    const pending = [
      {
        requestId: "p1",
        tool: "navigate",
        summary: "Go",
        conversationKey: key,
      },
    ];
    const listBrowserPermissionRequests = vi.fn(() => pending);
    const bus = new MainEventBus();
    const { client } = connect(
      fakeDeps({ bus, serviceHost: { listBrowserPermissionRequests } })
    );

    const events = await client.browser.events({ conversationKey: key });
    await expect(events.next()).resolves.toMatchObject({
      value: { type: "snapshot", permissionRequests: pending },
    });
    expect(listBrowserPermissionRequests).toHaveBeenCalledWith(key);

    const other = conversationKey(draftConversationRef("w2"));
    bus.dispatch({
      type: "browser-permission-request",
      request: {
        ...pending[0]!,
        requestId: "elsewhere",
        conversationKey: other,
      },
      emittedAt: at,
    } as IpcEvent);
    bus.dispatch({
      type: "browser-permission-request",
      request: { ...pending[0]!, requestId: "p2" },
      emittedAt: at,
    } as IpcEvent);

    await expect(events.next()).resolves.toMatchObject({
      value: { type: "permission-request", request: { requestId: "p2" } },
    });
    await events.return();
  });

  it("connectors.events snapshots the conversation's connector asks", async () => {
    const pending = [
      {
        requestId: "c1",
        connectorId: "github",
        label: "GitHub",
        conversationKey: key,
      },
    ];
    const { client } = connect(
      fakeDeps({ serviceHost: { listConnectorRequests: () => pending } })
    );

    const events = await client.connectors.events({ conversationKey: key });
    await expect(events.next()).resolves.toMatchObject({
      value: { type: "snapshot", requests: pending },
    });
    await events.return();
  });

  it("a keyless connectors.events reopened after asks were raised snapshots them all", async () => {
    // The real gate: two conversations ask before the subscriber (re)opens.
    const gate = new ConnectorGate(() => undefined);
    const other = conversationKey(draftConversationRef("w2"));
    void gate.ask({
      connectorId: "github",
      label: "GitHub",
      conversationKey: key,
    });
    void gate.ask({
      connectorId: "gmail",
      label: "Gmail",
      conversationKey: other,
    });
    const { client } = connect(
      fakeDeps({
        serviceHost: {
          listConnectorRequests: (k?: ConversationKey) => gate.listPending(k),
        },
      })
    );

    const events = await client.connectors.events({});
    const first = await events.next();
    expect(first.value).toMatchObject({ type: "snapshot" });
    expect(
      (
        first.value as { requests: Array<{ connectorId: string }> }
      ).requests.map((request) => request.connectorId)
    ).toEqual(["github", "gmail"]);
    await events.return();
  });

  it("a keyless browser.events reopened after asks were raised snapshots them all", async () => {
    const other = conversationKey(draftConversationRef("w2"));
    const pending = [
      {
        requestId: "p1",
        tool: "navigate",
        summary: "Go",
        conversationKey: key,
      },
      {
        requestId: "p2",
        tool: "click",
        summary: "Click",
        conversationKey: other,
      },
    ];
    const listBrowserPermissionRequests = vi.fn((k?: ConversationKey) =>
      pending.filter((request) => k == null || request.conversationKey === k)
    );
    const { client } = connect(
      fakeDeps({ serviceHost: { listBrowserPermissionRequests } })
    );

    const events = await client.browser.events({});
    await expect(events.next()).resolves.toMatchObject({
      value: { type: "snapshot", permissionRequests: pending },
    });
    expect(listBrowserPermissionRequests).toHaveBeenCalledWith(undefined);
    await events.return();
  });

  it("devices.events snapshots the status and where a build stands", async () => {
    const bus = new MainEventBus();
    const deps = fakeDeps({
      bus,
      serviceHost: { getDeviceStatus: () => ({ available: true }) },
    });
    bus.dispatch({
      type: "device-build-state",
      phase: "building",
      emittedAt: at,
    } as IpcEvent);
    const { client } = connect(deps);

    const events = await client.devices.events();
    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: "snapshot",
        status: { available: true },
        buildPhase: "building",
      },
    });
    await events.return();
  });
});
