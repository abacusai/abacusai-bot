/**
 * Low-end machines only: every chat keeps its own agent process (100 MB and
 * more) until it is archived or deleted, so a day of chats and routine runs
 * piles them up. This stops the ones nobody is using; the next message or
 * keystroke in that chat starts it again on the same conversation.
 *
 * Policy: a chat's agent stops after IDLE_STOP_MS without use, and at most
 * MAX_WARM_IDLE agents are kept idle at once, least recently used stopped
 * first (each at least CAP_GRACE_MS idle, so switching between two chats
 * never thrashes). An agent with anything in flight is never stopped and its
 * idle clock restarts when that ends: see `hold` in the host.
 */
import { AgentStatus } from "@abacus-ai/contract/agent-types";

import type { LiveAgentSession } from "./cli-manager-service";

/** Long enough to read a reply and answer; a restart costs a few seconds. */
const IDLE_STOP_MS = 10 * 60 * 1000;
/** The chat in front of the user and the one before it stay instant. */
const MAX_WARM_IDLE = 2;
/** The least an agent is idle before the cap may stop it. */
const CAP_GRACE_MS = 60 * 1000;
const SWEEP_MS = 30 * 1000;
/** After a start or a send, so the cap applies before the next sweep. */
const SETTLE_SWEEP_MS = 5 * 1000;

export interface IdleAgentReaperDeps {
  listLive: () => LiveAgentSession[];
  /** Why this session's agent must stay up (a run, a bot, a routine), or null. */
  hold: (workspaceId: string, sessionId: string) => string | null;
  stop: (workspaceId: string, sessionId: string) => void;
  log: (line: string) => void;
  now?: () => number;
  idleMs?: number;
  maxWarmIdle?: number;
  capGraceMs?: number;
  sweepMs?: number;
}

export class IdleAgentReaper {
  /** sessionId -> when it was last used or seen busy. */
  private readonly lastActive = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly maxWarmIdle: number;
  private readonly capGraceMs: number;
  private readonly sweepMs: number;

  constructor(private readonly deps: IdleAgentReaperDeps) {
    this.now = deps.now ?? Date.now;
    this.idleMs = deps.idleMs ?? IDLE_STOP_MS;
    this.maxWarmIdle = deps.maxWarmIdle ?? MAX_WARM_IDLE;
    this.capGraceMs = deps.capGraceMs ?? CAP_GRACE_MS;
    this.sweepMs = deps.sweepMs ?? SWEEP_MS;
  }

  start(): void {
    if (this.timer != null) return;
    this.timer = setInterval(() => this.sweep(), this.sweepMs);
    // Never the reason the app stays up.
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer != null) clearInterval(this.timer);
    if (this.settleTimer != null) clearTimeout(this.settleTimer);
    this.timer = null;
    this.settleTimer = null;
    this.lastActive.clear();
  }

  /** The user (or a routine, a bot) used this chat now: a start, a send. */
  touch(sessionId: string): void {
    this.lastActive.set(sessionId, this.now());
    if (this.timer == null || this.settleTimer != null) return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.sweep();
    }, SETTLE_SWEEP_MS);
    this.settleTimer.unref?.();
  }

  forget(sessionId: string): void {
    this.lastActive.delete(sessionId);
  }

  /** Stops what the policy says to; returns the sessions it stopped. */
  sweep(): string[] {
    const now = this.now();
    const live = this.deps.listLive();
    const liveIds = new Set(live.map((entry) => entry.sessionId));
    for (const sessionId of this.lastActive.keys())
      if (!liveIds.has(sessionId)) this.lastActive.delete(sessionId);

    const idle: Array<LiveAgentSession & { idleFor: number }> = [];
    for (const entry of live) {
      // First seen now: its clock starts here, never at zero.
      const last = this.lastActive.get(entry.sessionId) ?? now;
      if (
        entry.status !== "running" ||
        entry.agentStatus !== AgentStatus.Idle ||
        entry.backgroundLive > 0 ||
        this.deps.hold(entry.workspaceId, entry.sessionId) != null
      ) {
        // In use: the idle clock starts again when it settles.
        this.lastActive.set(entry.sessionId, now);
        continue;
      }
      this.lastActive.set(entry.sessionId, last);
      idle.push({ ...entry, idleFor: now - last });
    }

    // Most recently used first: the cap keeps the head of this list.
    idle.sort((a, b) => a.idleFor - b.idleFor);
    const stopped: string[] = [];
    idle.forEach((entry, index) => {
      const reason =
        entry.idleFor >= this.idleMs
          ? "idle"
          : index >= this.maxWarmIdle && entry.idleFor >= this.capGraceMs
            ? "cap"
            : null;
      if (reason == null) return;
      this.deps.log(
        `[idle-agents] stopped ${entry.sessionId.slice(0, 8)} reason=${reason} idle=${Math.round(entry.idleFor / 1000)}s live=${live.length} idleWarm=${idle.length}`
      );
      this.lastActive.delete(entry.sessionId);
      this.deps.stop(entry.workspaceId, entry.sessionId);
      stopped.push(entry.sessionId);
    });
    return stopped;
  }
}
