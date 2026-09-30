/**
 * The spec's "memory transport + real host" (spec 02 §13): main's real
 * `AguiRelayService` (`main/services/agui/relay-service.ts`) as the
 * `AguiSource` behind main's `ai.*` router over the memory transport, fed
 * by a real `AguiHost` from `packages/agent` driven in process against the
 * fake model provider (the agent's own `__tests__/live.ts` harness, agent
 * spec §7.2). Each `window()` is another memory transport on the same relay,
 * as a second renderer window is; `respawn()` replaces the agent process
 * (a new incarnation) as main does after an exit; `restartMain()` builds a
 * new relay over the thread files the old one persisted.
 *
 * Main and the agent are loaded by specifiers the compiler does not follow
 * (see `chat-relay.ts`); the few members used are restated below. The
 * agent must be the fake provider's: nothing here reaches a network.
 */
import type { AiClient } from "#next/data/ai";
import type { MemoryTransport } from "#next/data/transport/memory";
import type { AguiSourceLike } from "#next/features/chat/fixtures/ai-router";

import { loadUntyped, memoryAi } from "./chat-relay";

type Json = Record<string, unknown>;

/** A fake-provider reply (`@abacus-ai/test-support/fake-provider`). */
type Reply = Json;

interface Gates {
  wait(name: string): Promise<void>;
  open(name: string): void;
}

export type ReplyScript = (
  index: number,
  gates: Gates
) => Reply | Promise<Reply>;

/** `packages/agent/src/agui/__tests__/live.ts`'s handle, as used here. */
interface Live {
  gates: Gates;
  send(command: object): void;
  events(): Json[];
  onEvent(listener: (event: Json) => void): () => void;
  providerCalls(): number;
  close(): Promise<void>;
}

interface LiveModule {
  live(options: {
    reply: ReplyScript;
    incarnation?: string;
    isolated?: boolean;
  }): Promise<Live>;
}

/** Main's `AguiRelayService`, as used here. */
interface RelayService extends AguiSourceLike {
  ingest(
    threadId: string,
    event: Json,
    origin?: { wire: "agui"; runtime: object }
  ): void;
  runtimeExited(
    threadId: string,
    exit: {
      origin: { wire: "agui"; runtime: object };
      code: number | null;
      signal: null;
      requested: boolean;
    }
  ): void;
}

interface RelayModule {
  AguiRelayService: new (options: {
    host: {
      workspaceOf(threadId: string): string | null;
      runtime(threadId: string): { wire: "agui"; status: string } | null;
      start(threadId: string): Promise<boolean>;
      send(threadId: string, command: object): object | null;
      markSent(threadId: string): void;
      markStopped(threadId: string): void;
    };
    files: {
      readCurrentFile(threadId: string): Json | null;
      writeAgui(
        threadId: string,
        thread: { messages: unknown[]; runs: unknown[] }
      ): void;
      remove(threadId: string): void;
    };
    aguiForEverySpawn?: boolean;
    log?: (message: string) => void;
  }) => RelayService;
}

const LIVE = new URL(
  "../../../../../packages/agent/src/agui/__tests__/live.ts",
  import.meta.url
).pathname;
const RELAY = "#main/services/agui/relay-service";

/** The agent harness's thread id: `live()` builds its host for `t-1`. */
export const REAL_THREAD = "t-1";

export interface RealHost {
  /** Main's relay service (the `AguiSource` every window reads). */
  relay(): RelayService;
  /** Another renderer window: a memory transport on the same relay. */
  window(): Promise<AiClient>;
  /** Every AG-UI event the agent processes wrote, in order. */
  agentEvents(): Json[];
  /** `run` commands main wrote to an agent, per run id. */
  runsWritten(): string[];
  /** The live agent process's harness (throws before the first start). */
  agent(): Live;
  /** The agent process exits and a new one (another incarnation) starts. */
  respawn(): Promise<void>;
  /** A new main process: a new relay over the persisted thread files. */
  restartMain(): Promise<void>;
  /** The thread file main persisted, as written. */
  persisted(): { messages: unknown[]; runs: unknown[] } | null;
  close(): Promise<void>;
}

export const startRealHost = async (options: {
  reply: ReplyScript;
}): Promise<RealHost> => {
  const [{ live }, { AguiRelayService }] = await Promise.all([
    loadUntyped<LiveModule>(LIVE),
    loadUntyped<RelayModule>(RELAY),
  ]);
  const transports: MemoryTransport[] = [];
  const events: Json[] = [];
  const runs: string[] = [];
  let file: { messages: unknown[]; runs: unknown[] } | null = null;
  let agentProcess: {
    live: Live | null;
    token: object;
    status: string;
  } | null = null;
  let incarnations = 0;
  let relay!: RelayService;

  const attach = (runtime: { live: Live | null; token: object }): void => {
    const current = runtime.live!;
    const ingest = (event: Json): void => {
      events.push(event);
      relay.ingest(REAL_THREAD, event, {
        wire: "agui",
        runtime: runtime.token,
      });
    };
    // Read and subscribed in one turn: nothing is lost in between.
    for (const event of current.events()) ingest(event);
    current.onEvent(ingest);
  };

  const start = async (): Promise<boolean> => {
    incarnations += 1;
    const runtime = {
      live: null as Live | null,
      token: {},
      status: "starting",
    };
    agentProcess = runtime;
    runtime.live = await live({
      reply: options.reply,
      isolated: true,
      incarnation: `inc-${incarnations}`,
    });
    attach(runtime);
    runtime.status = "running";
    return true;
  };

  const createRelay = (): RelayService =>
    new AguiRelayService({
      host: {
        workspaceOf: (threadId) =>
          threadId === REAL_THREAD ? "/workspace" : null,
        runtime: () =>
          agentProcess == null
            ? null
            : { wire: "agui", status: agentProcess.status },
        start: () => start(),
        send: (_threadId, command) => {
          if (agentProcess?.live == null) return null;
          const typed = command as {
            type?: string;
            input?: { runId?: string };
          };
          if (typed.type === "run" && typed.input?.runId != null)
            runs.push(typed.input.runId);
          agentProcess.live.send(command);
          return agentProcess.token;
        },
        markSent: () => undefined,
        markStopped: () => undefined,
      },
      files: {
        readCurrentFile: () =>
          file == null
            ? null
            : {
                version: 2,
                threadId: REAL_THREAD,
                updatedAt: new Date(0).toISOString(),
                source: { kind: "agui" },
                messages: structuredClone(file.messages),
                runs: structuredClone(file.runs),
              },
        writeAgui: (_threadId, thread) => {
          file = structuredClone({
            messages: thread.messages,
            runs: thread.runs,
          });
        },
        remove: () => {
          file = null;
        },
      },
      aguiForEverySpawn: true,
      log: () => undefined,
    });

  relay = createRelay();
  const source: AguiSourceLike = new Proxy({} as AguiSourceLike, {
    // Windows follow a main restart: every call goes to the current relay.
    get: (_target, property) => {
      const value = (relay as unknown as Record<PropertyKey, unknown>)[
        property
      ];
      return typeof value === "function" ? value.bind(relay) : value;
    },
  });

  const stop = async (): Promise<void> => {
    const runtime = agentProcess;
    if (runtime?.live == null) return;
    runtime.status = "stopping";
    await runtime.live.close();
    relay.runtimeExited(REAL_THREAD, {
      origin: { wire: "agui", runtime: runtime.token },
      code: 0,
      signal: null,
      requested: true,
    });
    runtime.status = "stopped";
    agentProcess = null;
  };

  return {
    relay: () => relay,
    window: async () => {
      const { ai, transport } = await memoryAi(source);
      transports.push(transport);
      return ai;
    },
    agentEvents: () => events,
    runsWritten: () => runs,
    agent: () => {
      if (agentProcess?.live == null) throw new Error("no agent process yet");
      return agentProcess.live;
    },
    respawn: async () => {
      await stop();
      await start();
    },
    restartMain: async () => {
      await stop();
      relay = createRelay();
    },
    persisted: () => file,
    close: async () => {
      await stop();
      for (const transport of transports.splice(0)) transport.close();
    },
  };
};
