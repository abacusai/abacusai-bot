/**
 * Main's AG-UI relay end to end (agent spec §5.2, §7.2 "Real
 * AgentManagerService", §7.8; spec 02 §14): the real agent
 * (`packages/agent/dist/main.js --wire agui --compat-fd 3`) against the fake
 * model provider, spawned by the real `AgentManagerService`, relayed by
 * `AguiRelayService`, served by the real router over a MessageChannel, and
 * read by a real TanStack `ChatClient` bound the way the chat kit binds it
 * (spec 02 §3.3-§3.4: hydrate, then `joinRun` from the active run's start,
 * then `subscribe` from the last seq; admission through `ai.send`, never
 * through the client).
 *
 * Requires `packages/agent` built (`tsdown && node scripts/write-runtime-package.js`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FakeProvider,
  fakeProviderConfig,
  type Reply,
} from "@abacus-ai/test-support/fake-provider";
import { getEventMeta } from "@orpc/client";
import type { StreamChunk, UIMessage } from "@tanstack/ai";
import { ChatClient, type QueueStrategy } from "@tanstack/ai-client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AgentMode, type DesktopEvent } from "#shared/agent-types";
import type { PermissionDescriptor } from "#shared/contract";

import {
  connectInProcess,
  fakeDeps,
  type InProcessConnection,
  type TestClient,
} from "../../rpc/testing";
import { AgentManagerService } from "../session/cli-manager-service";
import { ThreadStore } from "../session/thread-store";
import { AguiRelayService } from "./relay-service";

const AGENT = path.join(
  import.meta.dirname,
  "../../../../../../packages/agent/dist/main.js"
);
const THREAD = "session-e2e";
const WAIT = { timeout: 45_000, interval: 20 };

let provider: FakeProvider;
/** This test's model: its own requests, counted from 0. */
let replies: (index: number) => Reply | Promise<Reply> = () => ({ say: "ok" });
let served = 0;
const savedEnv = new Map<string, string | undefined>();

const setEnv = (values: Record<string, string | undefined>): void => {
  for (const [key, value] of Object.entries(values)) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

beforeAll(async () => {
  if (!fs.existsSync(AGENT))
    throw new Error(`Build packages/agent first: ${AGENT} is missing`);
  provider = await FakeProvider.start();
  provider.script(() => replies(served++));
});

afterAll(async () => {
  await provider?.close();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface Stack {
  root: string;
  manager: AgentManagerService;
  relay: AguiRelayService;
  store: ThreadStore;
  client: TestClient;
  connection: InProcessConnection;
  /** Compat lines, as main's taps receive them. */
  compat: DesktopEvent[];
  marks: string[];
}

let stack: Stack | null = null;

afterEach(async () => {
  served = 0;
  if (stack == null) return;
  stack.connection.closeClient();
  stack.connection.closeServer();
  await stack.manager.dispose();
  fs.rmSync(stack.root, { recursive: true, force: true });
  stack = null;
});

/** The real manager and relay, as ServiceHost wires them. */
const build = (_options: { unused?: boolean } = {}): Stack => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agui-e2e-"));
  const home = path.join(root, "home");
  const user = path.join(root, "user");
  const workspace = path.join(root, "workspace");
  for (const dir of [home, user, workspace])
    fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(home, "config.json"),
    fakeProviderConfig(provider)
  );
  // The spawned agent inherits these (AgentManagerService passes process.env).
  setEnv({
    HOME: user,
    USERPROFILE: user,
    ABACUSAI_BOT_HOME: home,
    ABACUS_API_KEY: undefined,
    ROUTELLM_API_KEY: undefined,
  });

  const compat: DesktopEvent[] = [];
  const marks: string[] = [];
  const store = new ThreadStore({ home: () => home, log: () => undefined });

  let relay!: AguiRelayService;
  const manager = new AgentManagerService({
    resolveWorkspacePath: () => workspace,
    resolveArtifact: () => ({
      execPath: process.execPath,
      execArgs: [AGENT],
      agentRoot: path.dirname(AGENT),
    }),
    resolveAuthEnv: () => ({}),
    resolveAdditionalConfigEnv: async () => ({}),
    emitAgui: (_w, sessionId, event, origin) =>
      relay.ingest(sessionId, event, origin),
    emitAguiExit: (_w, sessionId, exit) => relay.runtimeExited(sessionId, exit),
    emitStateUpdated: () => {},
    emitNdjson: (_w, _s, event) => {
      compat.push(event);
    },
    emitSystemReady: () => {},
    emitSessionClosed: () => {},
    emitMcpRuntimeServers: () => {},
    emitMcpRuntimeStatus: () => {},
    emitMcpRuntimeLog: () => {},
    emitMcpRuntimeError: () => {},
    runHostService: async () => null,
  });
  relay = new AguiRelayService({
    files: store,
    startTimeoutMs: 45_000,
    ackTimeoutMs: 20_000,
    log: () => undefined,
    host: {
      workspaceOf: (threadId) => (threadId === THREAD ? "w1" : null),
      runtime: (threadId) => manager.getRuntimeInfo(threadId),
      start: async (threadId) =>
        (
          await manager.startSession({
            workspaceId: "w1",
            sessionId: threadId,
            mode: AgentMode.Normal,
            startupTimeoutMs: 45_000,
          })
        ).success,
      send: (threadId, command) =>
        manager.sendCommandToSession(threadId, command),
      markSent: () => marks.push("sent"),
      markStopped: () => marks.push("stopped"),
    },
  });
  const connection = connectInProcess(fakeDeps({ ai: relay }));
  stack = {
    root,
    manager,
    relay,
    store,
    client: connection.client,
    connection,
    compat,
    marks,
  };
  return stack;
};

const throwWhenBusy: QueueStrategy = ({ busyReason }) => {
  throw new Error(`chat: busy send (${busyReason})`);
};

type Event = Record<string, unknown> & { type: string };

/**
 * One window's chat binding, as the kit builds a generation (spec 02 §3.3):
 * a fresh ChatClient from `hydrate`, fed only by one pump (`joinRun` from the
 * active run's `RUN_STARTED`, then `subscribe` after the last seq).
 */
class Window {
  readonly events: Event[] = [];
  received: number;
  readonly chat: ChatClient;
  #buffer: StreamChunk[] = [];
  #wake: (() => void) | null = null;
  #subscription: AsyncIterator<unknown> | null = null;
  #closed = false;

  private constructor(
    readonly client: TestClient,
    snapshot: Awaited<ReturnType<TestClient["ai"]["hydrate"]>>
  ) {
    this.received = snapshot.abacus.activeRun
      ? snapshot.abacus.activeRun.startSeq - 1
      : snapshot.abacus.cursor;
    this.chat = new ChatClient({
      threadId: THREAD,
      initialMessages: snapshot.messages,
      queue: throwWhenBusy,
      connection: {
        subscribe: (signal?: AbortSignal) => this.#stream(signal),
        send: async () => {
          throw new Error("chat: send is not used");
        },
      },
    });
    this.chat.subscribe();
  }

  static async open(client: TestClient): Promise<Window> {
    const snapshot = await client.ai.hydrate({ threadId: THREAD });
    const window = new Window(client, snapshot);
    void window.#pump(snapshot.abacus.activeRun?.runId ?? null);
    return window;
  }

  /** Stops reading, as a closed port does; the client keeps what it has. */
  async disconnect(): Promise<void> {
    this.#closed = true;
    await this.#subscription?.return?.(undefined);
  }

  /** Reads on from `received` over a new subscription (a reconnect). */
  reconnect(): void {
    this.#closed = false;
    void this.#pump(null);
  }

  has(predicate: (event: Event) => boolean): boolean {
    return this.events.some(predicate);
  }

  custom<T>(name: string): T[] {
    return this.events
      .filter((event) => event.type === "CUSTOM" && event.name === name)
      .map((event) => event.value as T);
  }

  async #pump(activeRunId: string | null): Promise<void> {
    if (activeRunId != null) {
      for await (const event of await this.client.ai.joinRun({
        runId: activeRunId,
      }))
        this.#accept(event as unknown as Event);
    }
    if (this.#closed) return;
    const stream = await this.client.ai.subscribe({
      threadId: THREAD,
      lastEventId: String(this.received),
    });
    this.#subscription = stream;
    try {
      for await (const event of stream) this.#accept(event as unknown as Event);
    } catch {
      // Closed by disconnect().
    }
  }

  #accept(event: Event): void {
    const id = getEventMeta(event)?.id;
    if (id == null) return; // abacus.subscribed / abacus.resync
    const seq = Number(id);
    if (seq <= this.received) return;
    this.received = seq;
    this.events.push(event);
    this.#buffer.push(event as unknown as StreamChunk);
    this.#wake?.();
  }

  async *#stream(signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    for (;;) {
      while (this.#buffer.length > 0) yield this.#buffer.shift()!;
      if (signal?.aborted === true) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      this.#wake = null;
    }
  }
}

const isTerminal = (runId: string) => (event: Event) =>
  (event.type === "RUN_FINISHED" && event.runId === runId) ||
  (event.type === "RUN_ERROR" &&
    (event.metadata as { tanstack?: { runId?: string } } | undefined)?.tanstack
      ?.runId === runId);

const userMessage = (id: string, content: string) => ({
  id,
  role: "user" as const,
  parts: [{ type: "text", content }],
});

/** Messages without wall-clock fields, for comparing two processors. */
const timeless = (messages: UIMessage[]): unknown =>
  JSON.parse(
    JSON.stringify(messages, (key, value: unknown) =>
      key === "createdAt" ? undefined : value
    )
  );

const textOf = (message: UIMessage | undefined): string =>
  (message?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => (part as { content: string }).content)
    .join("");

const writeThenReply: (index: number) => Reply = (index) =>
  index === 0
    ? { call: { name: "write", args: { path: "a.txt", content: "hello\n" } } }
    : { say: "Wrote it." };

describe("main's AG-UI relay with a spawned agent", () => {
  it("send → permission → respond → RUN_FINISHED, into a ChatClient; compat still feeds the taps", async () => {
    const { client, store, compat, marks } = build();
    replies = writeThenReply;
    const window = await Window.open(client);

    await expect(
      client.ai.send({
        threadId: THREAD,
        runId: "run-1",
        messages: [userMessage("u-1", "write a file")],
      })
    ).resolves.toEqual({ runId: "run-1", status: "started" });
    expect(marks).toEqual(["sent"]);

    await vi.waitFor(
      () => expect(window.custom("permission.requested")).toHaveLength(1),
      WAIT
    );
    const [descriptor] = window.custom<PermissionDescriptor>(
      "permission.requested"
    );
    expect(descriptor!.metadata.abacus.lineage).toMatchObject({
      threadId: THREAD,
      runId: "run-1",
      permissionId: "perm-1",
    });
    // A second window opened now sees the card in the snapshot.
    expect(
      (await client.ai.hydrate({ threadId: THREAD })).abacus.permissions
    ).toHaveLength(1);

    await client.ai.respondPermission({
      threadId: THREAD,
      lineage: descriptor!.metadata.abacus.lineage,
      decision: "accept",
    });
    await vi.waitFor(
      () => expect(window.has(isTerminal("run-1"))).toBe(true),
      WAIT
    );

    await vi.waitFor(() => {
      const messages = window.chat.getMessages();
      expect(messages.map((m) => m.role)).toEqual([
        "user",
        "assistant",
        "assistant",
      ]);
      expect(messages[0]!.id).toBe("u-1");
      expect(textOf(messages[0])).toBe("write a file");
      expect(textOf(messages.at(-1))).toBe("Wrote it.");
    }, WAIT);
    const toolCall = window.chat
      .getMessages()[1]!
      .parts.find((part) => part.type === "tool-call") as
      | { name: string; output?: { text: string } }
      | undefined;
    expect(toolCall).toMatchObject({ name: "write" });

    // The taps read today's NDJSON from compat.
    expect(compat.map((event) => event.type)).toContain("ready");
    expect(
      compat.some(
        (event) =>
          event.type === "event" &&
          (event.event as { type: string }).type === "tool_execution_complete"
      )
    ).toBe(true);

    // Persisted at the terminal, with the outcome.
    const file = store.readCurrentFile(THREAD);
    expect(file?.source.kind).toBe("agui");
    expect(file?.runs).toEqual([
      expect.objectContaining({ runId: "run-1", kind: "success", steps: 1 }),
    ]);
    expect(timeless(file!.messages)).toEqual(
      timeless(window.chat.getMessages())
    );
    await window.disconnect();
  }, 90_000);

  it("a window that reconnects with its last event id, and one hydrated mid-run, both end where the live one does", async () => {
    const { client } = build();
    replies = writeThenReply;
    const live = await Window.open(client);
    const reconnecting = await Window.open(client);
    await client.ai.send({
      threadId: THREAD,
      runId: "run-1",
      messages: [userMessage("u-1", "write a file")],
    });
    await vi.waitFor(
      () => expect(reconnecting.custom("permission.requested")).toHaveLength(1),
      WAIT
    );

    // Dropped mid-run; everything after its last id is replayed on return.
    await reconnecting.disconnect();
    const lastSeen = reconnecting.received;
    // Opened mid-run: hydrate (without the active run) + joinRun from its start.
    const late = await Window.open(client);
    expect(
      late.events.length === 0 || late.events[0]!.type === "RUN_STARTED"
    ).toBe(true);

    const [descriptor] = live.custom<PermissionDescriptor>(
      "permission.requested"
    );
    await client.ai.respondPermission({
      threadId: THREAD,
      lineage: descriptor!.metadata.abacus.lineage,
      decision: "accept",
    });
    await vi.waitFor(
      () => expect(live.has(isTerminal("run-1"))).toBe(true),
      WAIT
    );
    reconnecting.reconnect();

    for (const window of [reconnecting, late]) {
      await vi.waitFor(
        () => expect(window.has(isTerminal("run-1"))).toBe(true),
        WAIT
      );
      await vi.waitFor(
        () =>
          expect(timeless(window.chat.getMessages())).toEqual(
            timeless(live.chat.getMessages())
          ),
        WAIT
      );
    }
    expect(reconnecting.received).toBeGreaterThan(lastSeen);
    // Nothing doubled: exactly one terminal each.
    for (const window of [live, reconnecting, late])
      expect(window.events.filter(isTerminal("run-1"))).toHaveLength(1);
    for (const window of [live, reconnecting, late]) await window.disconnect();
  }, 90_000);

  it("across a respawn: a repeated run id is a duplicate, and a retry's user echo is not doubled", async () => {
    const { client, manager } = build();
    replies = (index) => ({ say: index === 0 ? "First." : "Second." });
    await client.ai.send({
      threadId: THREAD,
      runId: "run-1",
      messages: [userMessage("u-1", "question")],
    });
    const window = await Window.open(client);
    await vi.waitFor(async () => {
      expect(
        (await client.ai.hydrate({ threadId: THREAD })).abacus.runOutcomes
      ).toHaveLength(1);
    }, WAIT);
    const firstIncarnation = (await client.ai.hydrate({ threadId: THREAD }))
      .abacus.incarnation;

    // The agent goes away between turns.
    await manager.stopSessionAndWait("w1", THREAD);

    // The client never saw its ack and re-sends the same run id: no new run.
    await expect(
      client.ai.send({
        threadId: THREAD,
        runId: "run-1",
        messages: [userMessage("u-1", "question")],
      })
    ).resolves.toEqual({
      runId: "run-1",
      status: "duplicate",
      original: "started",
    });
    expect(manager.getRuntimeInfo(THREAD)).toBeNull();

    // A retry of the same message on a new run: the new process echoes u-1
    // again, which the transcript already holds.
    await expect(
      client.ai.send({
        threadId: THREAD,
        runId: "run-2",
        messages: [userMessage("u-1", "question")],
      })
    ).resolves.toEqual({ runId: "run-2", status: "started" });
    await vi.waitFor(
      () => expect(window.has(isTerminal("run-2"))).toBe(true),
      WAIT
    );

    const hydrated = await client.ai.hydrate({ threadId: THREAD });
    expect(hydrated.abacus.incarnation).not.toBe(firstIncarnation);
    const users = hydrated.messages.filter((m) => m.role === "user");
    expect(users.map((m) => [m.id, textOf(m)])).toEqual([["u-1", "question"]]);
    expect(
      hydrated.messages.filter((m) => m.role === "assistant").map(textOf)
    ).toEqual(["First.", "Second."]);
    await vi.waitFor(
      () =>
        expect(timeless(window.chat.getMessages())).toEqual(
          timeless(hydrated.messages)
        ),
      WAIT
    );
    await window.disconnect();
  }, 120_000);

  it("converts text, multi-line and attachment-only UIMessages at the boundary, keeping the client ids (spec 02 §14.2)", async () => {
    const { client } = build();
    replies = () => ({ say: "ok" });
    const window = await Window.open(client);
    const cases = [
      ["u-text", "plain text"],
      ["u-lines", "first line\nsecond line\n\nfourth"],
      ["u-attach", "@/tmp/report.pdf\n@/tmp/chart.png"],
    ] as const;

    for (const [index, [id, text]] of cases.entries()) {
      const runId = `run-${index}`;
      await expect(
        client.ai.send({
          threadId: THREAD,
          runId,
          messages: [userMessage(id, text)],
        })
      ).resolves.toEqual({ runId, status: "started" });
      await vi.waitFor(
        () => expect(window.has(isTerminal(runId))).toBe(true),
        WAIT
      );
      const echo = window.events.filter(
        (event) =>
          event.type === "TEXT_MESSAGE_CONTENT" && event.messageId === id
      );
      expect(echo.map((event) => event.delta).join("")).toBe(text);
    }

    const users = (
      await client.ai.hydrate({ threadId: THREAD })
    ).messages.filter((message) => message.role === "user");
    expect(users.map((m) => [m.id, textOf(m)])).toEqual(
      cases.map(([id, text]) => [id, text])
    );
    await window.disconnect();
  }, 120_000);

  it("a signal exit mid-run gets main's RUN_ERROR, and the thread settles", async () => {
    const { client, manager } = build();
    replies = () => ({ stall: { say: "Partial" } });
    const window = await Window.open(client);
    await client.ai.send({
      threadId: THREAD,
      runId: "run-1",
      messages: [userMessage("u-1", "go")],
    });
    await vi.waitFor(
      () =>
        expect(
          window.has(
            (event) =>
              event.type === "TEXT_MESSAGE_CONTENT" && event.delta === "Partial"
          )
        ).toBe(true),
      WAIT
    );

    const pid = manager.getSessionState("w1", THREAD).pid!;
    process.kill(pid, "SIGKILL");

    await vi.waitFor(
      () => expect(window.has(isTerminal("run-1"))).toBe(true),
      WAIT
    );
    const terminal = window.events.find(isTerminal("run-1"))!;
    expect(terminal).toMatchObject({
      type: "RUN_ERROR",
      code: "agent_crashed",
    });

    const hydrated = await client.ai.hydrate({ threadId: THREAD });
    expect(hydrated.activeRun).toBeNull();
    expect(hydrated.abacus.runOutcomes.at(-1)).toMatchObject({
      runId: "run-1",
      kind: "error",
      error: { code: "agent_crashed" },
    });
    // The client's run settled on it (its processor saw the terminal).
    await vi.waitFor(
      () =>
        expect(textOf(window.chat.getMessages().at(-1))).toContain("Partial"),
      WAIT
    );
    await window.disconnect();
  }, 90_000);

  it("a kill inside a tool call settles the call: the hydrated part is not left streaming (review r1)", async () => {
    const { client, manager } = build();
    replies = writeThenReply;
    const window = await Window.open(client);
    await client.ai.send({
      threadId: THREAD,
      runId: "run-1",
      messages: [userMessage("u-1", "write a file")],
    });
    // The write is announced and waits on its permission.
    await vi.waitFor(
      () => expect(window.custom("permission.requested")).toHaveLength(1),
      WAIT
    );

    process.kill(manager.getSessionState("w1", THREAD).pid!, "SIGKILL");
    await vi.waitFor(
      () => expect(window.has(isTerminal("run-1"))).toBe(true),
      WAIT
    );

    const hydrated = await client.ai.hydrate({ threadId: THREAD });
    const parts = hydrated.messages.flatMap(
      (message) => message.parts as unknown as Array<Record<string, unknown>>
    );
    const call = parts.find((part) => part.type === "tool-call");
    expect(call).toMatchObject({ name: "write" });
    expect(["input-streaming", "awaiting-input"]).not.toContain(call!.state);
    expect(
      parts.find(
        (part) => part.type === "tool-result" && part.toolCallId === call!.id
      )
    ).toMatchObject({ state: "error" });
    // The live window ends where the transcript does.
    await vi.waitFor(
      () =>
        expect(timeless(window.chat.getMessages())).toEqual(
          timeless(hydrated.messages)
        ),
      WAIT
    );
    await window.disconnect();
  }, 90_000);

  it("in the new-renderer build, a spawn no ai.* call asked for speaks AG-UI and the new UI drives it (review r1)", async () => {
    const { client, manager } = build({});
    replies = () => ({ say: "ok" });

    // A routine, a bot reply or a restored session: started by main itself.
    await expect(
      manager.startSession({
        workspaceId: "w1",
        sessionId: THREAD,
        mode: AgentMode.Normal,
        startupTimeoutMs: 45_000,
      })
    ).resolves.toMatchObject({ success: true });
    expect(manager.getRuntimeInfo(THREAD)?.wire).toBe("agui");

    const window = await Window.open(client);
    await expect(
      client.ai.send({
        threadId: THREAD,
        runId: "run-1",
        messages: [userMessage("u-1", "hello")],
      })
    ).resolves.toEqual({ runId: "run-1", status: "started" });
    await vi.waitFor(
      () => expect(window.has(isTerminal("run-1"))).toBe(true),
      WAIT
    );
    expect(textOf(window.chat.getMessages().at(-1))).toBe("ok");
    await window.disconnect();
  }, 90_000);
});
