/**
 * A scripted stand-in for the pi session behind a real AguiHost, for what
 * the fake provider cannot drive (reviews/00-agent-agui.impl-fixes-r1.md):
 * permissions that are pending at the same time (pi 0.85 gates sibling calls
 * one after another; only sandbox asks overlap, and those need an OS sandbox),
 * housekeeping permissions, and the randomized host properties of §7.4.
 *
 * It speaks the session's side of the host contract exactly as
 * AbacusBotSession does: legacy events through `emit`, internal facts through
 * `emitInternal`, `turn.settled()` once the user-visible turn is over, one
 * waiter per permission that `respondPermission` releases, and `stop()`
 * returning only once the aborted turn has stopped emitting.
 */
import { tagEvent, type EventMeta } from "../../event-meta.js";
import type { InternalAgentEvent } from "../../internal-events.js";
import {
  AgentStatus,
  type AgentEvent,
  type DesktopEvent,
  type PermissionDecision,
  type PermissionRequest,
  type ToolRequest,
} from "../../protocol.js";
import type { AbacusBotSession, TurnHandle } from "../../session.js";
import { AguiHost, type SessionInit } from "../host.js";
import type { AguiEvent } from "../wire.js";

export type Answer = PermissionDecision | "expired" | "stopped";

/** What a scripted turn can do. */
export interface TurnApi {
  readonly text: string;
  /** The nth `send` of this session, from 1. */
  readonly index: number;
  agent(event: AgentEvent, meta?: EventMeta): void;
  emit(event: DesktopEvent): void;
  internal(event: InternalAgentEvent): void;
  /** Raises a permission and waits for its answer (or expiry, or a Stop). */
  ask(permissionId: string, request: PermissionRequest): Promise<Answer>;
  /** Clears a pending permission as its approval budget running out does. */
  expire(permissionId: string): void;
  /** The user-visible turn is over (housekeeping may follow). */
  settled(): void;
  /** True once a Stop or reset aborted this turn. */
  aborted(): boolean;
  /** Waits for a named gate the test opens. */
  gate(name: string): Promise<void>;
}

export type TurnScript = (api: TurnApi) => Promise<void>;

/** A few event-loop turns: long enough for queued stdin lines to be read. */
const landing = async (): Promise<void> => {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

export const toolRequest = (
  id: string,
  name: string,
  input: Record<string, unknown>
): ToolRequest => ({ id, name, type: name, input, args: input });

export class ScriptedSession {
  readonly sent: string[] = [];
  readonly steered: string[] = [];
  /** The sender's id per send and per steer, in order; undefined when none. */
  readonly sentIds: Array<string | undefined> = [];
  readonly steeredIds: Array<string | undefined> = [];
  readonly answers: Array<{
    permissionId: string;
    decision: PermissionDecision;
  }> = [];
  /** Concurrent `send` calls right now, and the most ever seen. */
  inFlight = 0;
  maxInFlight = 0;
  /** Sends that reached the session while a Stop or reset was landing. */
  readonly sentDuringAbort: string[] = [];
  private aborting = 0;
  private sends = 0;
  private generation = 0;
  private readonly waiters = new Map<string, (answer: Answer) => void>();
  private readonly gates = new Map<string, Array<() => void>>();
  private readonly opened = new Set<string>();
  private sessionN = 1;

  constructor(
    private readonly init: SessionInit,
    private readonly script: TurnScript
  ) {}

  open(name: string): void {
    this.opened.add(name);
    for (const release of this.gates.get(name) ?? []) release();
    this.gates.delete(name);
  }

  private gate(name: string): Promise<void> {
    if (this.opened.has(name)) return Promise.resolve();

    return new Promise((resolve) =>
      this.gates.set(name, [...(this.gates.get(name) ?? []), resolve])
    );
  }

  private agent(event: AgentEvent, meta?: EventMeta): void {
    this.init.emit({
      type: "event",
      event: meta != null ? tagEvent(event, meta) : event,
    });
  }

  private ready(): void {
    this.init.emit({
      type: "ready",
      model: "fake/fake-1",
      mode: "DEFAULT",
      agentSessionId: `s-${this.sessionN}`,
      agentSessionFile: `/sessions/s-${this.sessionN}.jsonl`,
    });
  }

  async start(): Promise<void> {
    this.ready();
    this.init.emit({ type: "skills_loaded", skills: [] });
    this.init.emit({ type: "mcp_servers", servers: [] });
  }

  async send(text: string, turn?: TurnHandle): Promise<void> {
    if (this.aborting > 0) this.sentDuringAbort.push(text);
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    this.sends += 1;
    this.sent.push(text);
    this.sentIds.push(turn?.messageId);

    const generation = this.generation;
    let settled = false;
    const live = (): boolean => generation === this.generation;
    const api: TurnApi = {
      text,
      index: this.sends,
      // An aborted turn emits nothing more, as pi's abort guarantees once
      // `stop()` has resolved.
      agent: (event, meta) => {
        if (live()) this.agent(event, meta);
      },
      emit: (event) => {
        if (live()) this.init.emit(event);
      },
      internal: (event) => {
        // BotSession.runHiddenTurn closes its bracket in a `finally`, so the
        // end of a hidden turn arrives even when the turn was aborted.
        if (live() || event.type === "hidden_turn") {
          this.init.emitInternal(event);
        }
      },
      ask: (permissionId, request) => {
        if (!live()) return Promise.resolve("stopped");

        this.init.emit({ type: "permission_needed", permissionId, request });
        this.agent({
          type: "status_changed",
          status: AgentStatus.WaitingForToolPermission,
        });

        return new Promise<Answer>((resolve) =>
          this.waiters.set(permissionId, (answer) => {
            if (live()) {
              this.agent({
                type: "status_changed",
                status: AgentStatus.ExecutingTool,
              });
            }
            resolve(answer);
          })
        );
      },
      expire: (permissionId) => {
        const waiter = this.waiters.get(permissionId);

        if (waiter == null) return;
        this.waiters.delete(permissionId);
        this.agent({ type: "permission_cleared", permissionId });
        waiter("expired");
      },
      settled: () => {
        if (settled) return;
        settled = true;
        turn?.settled?.();
      },
      aborted: () => !live(),
      gate: (name) => this.gate(name),
    };

    try {
      this.agent({ type: "status_changed", status: AgentStatus.Submitted });
      await this.script(api);
      if (live()) {
        this.agent({ type: "turn_complete" });
        this.agent({ type: "status_changed", status: AgentStatus.Idle });
      }
      api.settled();
    } finally {
      this.inFlight -= 1;
    }
  }

  /** Aborts the turn: pending permissions clear, and it emits nothing more. */
  async stop(): Promise<void> {
    this.aborting += 1;
    try {
      this.abort();
      // Landing takes a while, as pi's abort does: commands race it.
      await landing();
    } finally {
      this.aborting -= 1;
    }
  }

  private abort(): void {
    // Deleting the entry being visited is safe in a Map iteration.
    for (const [permissionId, waiter] of this.waiters) {
      this.waiters.delete(permissionId);
      this.agent({ type: "permission_cleared", permissionId });
      waiter("stopped");
    }
    this.generation += 1;
    // An abort ends whatever the turn was waiting on, as pi's does: the
    // aborted turn unwinds (closing a hidden bracket) and emits nothing more.
    for (const [name, releases] of this.gates) {
      this.gates.delete(name);
      for (const release of releases) release();
    }
  }

  async resetConversation(): Promise<void> {
    this.aborting += 1;
    try {
      this.abort();
      await landing();
      this.sessionN += 1;
      this.ready();
      this.agent({ type: "segments_cleared" });
      this.agent({ type: "status_changed", status: AgentStatus.Idle });
    } finally {
      this.aborting -= 1;
    }
  }

  setMode(): void {}

  async setModel(): Promise<void> {}

  async refreshProviders(): Promise<void> {}

  hasPendingPermission(permissionId: string): boolean {
    return this.waiters.has(permissionId);
  }

  respondPermission(permissionId: string, decision: PermissionDecision): void {
    const waiter = this.waiters.get(permissionId);

    if (waiter == null) return;
    this.waiters.delete(permissionId);
    this.answers.push({ permissionId, decision });
    waiter(decision);
  }

  async steer(message: string, messageId?: string): Promise<void> {
    this.steered.push(message);
    this.steeredIds.push(messageId);
  }

  dropSteers(): void {}

  emitMcpServers(): void {}

  async refreshMcp(): Promise<void> {}

  settleHostService(): void {}

  dispose(): void {}
}

/** A real AguiHost over a ScriptedSession, with its streams captured. */
export interface Scripted {
  host: AguiHost;
  session: ScriptedSession;
  send(command: object): void;
  events(): AguiEvent[];
  compat(): string;
  custom<T = unknown>(name: string): T[];
  waitFor(
    check: (events: AguiEvent[]) => boolean,
    label: string
  ): Promise<void>;
  close(): Promise<void>;
}

export async function scripted(
  script: TurnScript,
  options: { incarnation?: string; threadId?: string } = {}
): Promise<Scripted> {
  const { PassThrough } = await import("node:stream");
  const stdin = new PassThrough();
  let stdout = "";
  let compat = "";
  let session: ScriptedSession | undefined;
  const host = new AguiHost({
    cwd: "/nowhere",
    threadId: options.threadId ?? "t-1",
    incarnation: options.incarnation ?? "inc-1",
    compat: {
      mode: "fd",
      write: (line) => {
        compat += line;
      },
    },
    stdin,
    writeStdout: (text) => {
      stdout += text;
    },
    exit: () => undefined,
    log: () => undefined,
    session: (init) => {
      session = new ScriptedSession(init, script);

      return session as unknown as AbacusBotSession;
    },
  });
  const done = host.run();
  const events = (): AguiEvent[] =>
    stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as AguiEvent);
  const waitFor = async (
    check: (all: AguiEvent[]) => boolean,
    label: string
  ): Promise<void> => {
    const deadline = Date.now() + 5_000;

    while (!check(events())) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${label}; saw ${events()
            .map((event) =>
              event.type === "CUSTOM" ? `CUSTOM:${event.name}` : event.type
            )
            .join(", ")}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };

  await waitFor(
    (all) =>
      all.some(
        (event) => event.type === "CUSTOM" && event.name === "mcp.servers"
      ),
    "startup"
  );

  return {
    host,
    session: session!,
    send: (command) => stdin.write(`${JSON.stringify(command)}\n`),
    events,
    compat: () => compat,
    custom: <T>(name: string) =>
      events()
        .filter((event) => event.type === "CUSTOM" && event.name === name)
        .map((event) => (event as { value: T }).value),
    waitFor,
    close: async () => {
      stdin.end();
      await done;
    },
  };
}
