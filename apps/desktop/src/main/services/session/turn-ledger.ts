import * as fs from "node:fs";
import * as path from "node:path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";
import {
  type AgentEvent,
  AgentStatus,
  type DesktopEvent,
  type TurnOutcome,
} from "@abacus-ai/contract/agent-types";

/**
 * How a turn ended. The agent's own outcomes, plus the endings only main sees:
 * the inactivity watchdog, the agent process going away mid-turn, and the app
 * itself closing (a quit, an update, a crash) with the turn still open.
 */
export type TurnEnd =
  | TurnOutcome["kind"]
  | "timed_out"
  | "agent_exited"
  | "app_closed";

/** Where a turn's ending has to be told besides the app: a chat it answers. */
export interface TurnChannel {
  platform: string;
  chatId: string;
  /** The user's own chat (else a contact they auto-reply to). */
  owner: boolean;
  userName: string | null;
}

/** The error a turn reported, as its event carried it. */
export type TurnError = Extract<AgentEvent, { type: "error" }>["error"];

export interface TurnRecord {
  turnId: string;
  sessionId: string;
  kind: TurnEnd;
  /** Why: the error's cause for `failed`, what was running for `timed_out`. */
  cause?: string;
  /** For `failed`: the error the turn reported, actions and all. */
  error?: TurnError;
  startedAt: number;
  endedAt: number;
  /** Set when the turn answered a chat app; see annotate. */
  channel?: TurnChannel;
}

interface OpenTurn {
  turnId: string;
  startedAt: number;
  /** Assistant text was streamed: what an outcome-less agent's turn is judged by. */
  spoke: boolean;
  error: TurnError | null;
  outcome: TurnOutcome | null;
  channel?: TurnChannel;
}

/** What the journal keeps of an open turn, enough to close it after a restart. */
interface JournalEntry {
  sessionId: string;
  turnId: string;
  startedAt: number;
  channel?: TurnChannel;
}

export interface TurnLedgerOptions {
  now?: () => number;
  /** One line per closed turn, for the synced `agent` log. */
  log?: (line: string) => void;
  /** Where closed turns are kept for the transcript upload; null keeps none. */
  dir?: (() => string) | null;
  /**
   * The file open turns are journaled to, so a turn the app closed under
   * (a quit, an update, a crash) is closed on the next start; null keeps none.
   */
  journal?: (() => string) | null;
}

/** Closed turns kept per session for the upload. */
const RECORDS_KEPT = 200;

/**
 * Every turn a send opens is closed exactly once, with how it ended.
 *
 * Opened when a message is sent; closed by the agent's idle (its outcome
 * read off the closing `turn_complete`, or worked out from what it streamed
 * when the agent is older), by a Stop, by the watchdog, or by the agent going
 * away. The first ending wins and later ones are ignored, so the chat app,
 * the routine record and the log all hear about one ending, not none or two.
 */
export class TurnLedger {
  private readonly open = new Map<string, OpenTurn>();
  /** A chat named for the send about to open a turn; see annotate. */
  private readonly pendingChannel = new Map<string, TurnChannel>();
  private readonly listeners = new Set<(record: TurnRecord) => void>();
  private sequence = 0;
  /** The app is going away; see appClosing. */
  private closingApp = false;

  constructor(private readonly options: TurnLedgerOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** A message went to the session; a turn already open keeps going. */
  begin(sessionId: string): void {
    if (this.closingApp) return;
    const channel = this.pendingChannel.get(sessionId);
    this.pendingChannel.delete(sessionId);
    if (this.open.has(sessionId)) {
      if (channel != null) this.annotate(sessionId, channel);
      return;
    }
    this.sequence += 1;
    const startedAt = this.now();
    this.open.set(sessionId, {
      turnId: `${startedAt.toString(36)}-${this.sequence.toString(36)}`,
      startedAt,
      spoke: false,
      error: null,
      outcome: null,
      ...(channel != null ? { channel } : {}),
    });
    this.saveJournal();
  }

  /** The open turn answers a chat app: its ending is owed there too. */
  annotate(sessionId: string, channel: TurnChannel): void {
    const turn = this.open.get(sessionId);
    // Named just before its send: the turn the send opens takes it.
    if (turn == null) {
      this.pendingChannel.set(sessionId, channel);
      return;
    }
    turn.channel = channel;
    this.saveJournal();
  }

  /**
   * Close every turn the last run left open, as `app_closed`: the app went
   * away (a quit, an update, a crash) before the turn ended. Call once at
   * start, before any send; the listeners hear each close like any other.
   * A turn leaves the journal only after its listeners ran, so a crash in
   * between replays it on the next start: listeners must be idempotent
   * per turnId, as the chat outbox and the routine record are.
   */
  recover(): void {
    // A start: nothing from before it is open in memory, whatever the journal says.
    this.closingApp = false;
    this.open.clear();
    this.pendingChannel.clear();
    const file = this.options.journal?.();
    if (file == null) return;
    let entries: JournalEntry[] = [];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) entries = parsed as JournalEntry[];
    } catch {
      // No journal: nothing was open.
    }
    for (const entry of entries) {
      if (
        typeof entry?.sessionId !== "string" ||
        typeof entry.turnId !== "string" ||
        this.open.has(entry.sessionId)
      )
        continue;
      this.open.set(entry.sessionId, {
        turnId: entry.turnId,
        startedAt: entry.startedAt,
        spoke: false,
        error: null,
        outcome: null,
        ...(entry.channel != null ? { channel: entry.channel } : {}),
      });
      this.close(entry.sessionId, { kind: "app_closed" });
    }
  }

  isOpen(sessionId: string): boolean {
    return this.open.has(sessionId);
  }

  /** Feed the session's agent events; its idle closes the open turn. */
  observe(sessionId: string, message: DesktopEvent): void {
    const turn = this.open.get(sessionId);
    if (turn == null || message.type !== "event") return;
    const event = message.event;
    switch (event.type) {
      case "text_delta":
        if (event.content.trim().length > 0) turn.spoke = true;
        return;
      case "error":
        turn.error = event.error ?? {};
        return;
      case "turn_complete":
        if (event.outcome != null) turn.outcome = event.outcome;
        return;
      case "status_changed":
        if (event.status !== AgentStatus.Idle) return;
        this.close(sessionId, this.agentEnding(turn));
        return;
      default:
        return;
    }
  }

  /**
   * The app is going away (a quit, an update's install). From here on no turn
   * closes: the agents stopping under it are the quit, not how their turns
   * ended, and a chat line worded as the app shuts down would never be sent.
   * What is open stays journaled and closes as `app_closed` on the next
   * start, where its chat is told like any other ending.
   */
  appClosing(): void {
    this.closingApp = true;
  }

  /** A turn main ended itself; ignored once the turn has closed. */
  end(sessionId: string, kind: TurnEnd, cause?: string): void {
    this.close(sessionId, { kind, ...(cause != null ? { cause } : {}) });
  }

  onClose(listener: (record: TurnRecord) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The session's closed turns, oldest first, as kept for the upload. */
  records(sessionId: string): TurnRecord[] {
    const file = this.fileOf(sessionId);
    if (file == null) return [];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(parsed) ? (parsed as TurnRecord[]) : [];
    } catch {
      return [];
    }
  }

  /** The agent's own outcome, else one read off what the turn streamed. */
  private agentEnding(turn: OpenTurn): { kind: TurnEnd; cause?: string } {
    if (turn.outcome != null)
      return {
        kind: turn.outcome.kind,
        ...(turn.outcome.cause != null ? { cause: turn.outcome.cause } : {}),
      };
    if (turn.error != null)
      return {
        kind: "failed",
        cause: turn.error.cause ?? turn.error.code ?? "error",
      };
    // Nothing said and nothing reported: the empty-reply failure's cause.
    return turn.spoke ? { kind: "reply" } : { kind: "failed", cause: "empty" };
  }

  private close(
    sessionId: string,
    ending: { kind: TurnEnd; cause?: string }
  ): void {
    const turn = this.open.get(sessionId);
    if (turn == null || this.closingApp) return;
    this.open.delete(sessionId);
    this.pendingChannel.delete(sessionId);
    const record: TurnRecord = {
      turnId: turn.turnId,
      sessionId,
      kind: ending.kind,
      ...(ending.cause != null ? { cause: ending.cause } : {}),
      ...(ending.kind === "failed" && turn.error != null
        ? { error: turn.error }
        : {}),
      startedAt: turn.startedAt,
      endedAt: this.now(),
      ...(turn.channel != null ? { channel: turn.channel } : {}),
    };
    this.options.log?.(
      `[${sessionId.slice(0, 8)}] turn outcome ${record.kind}` +
        (record.cause != null ? ` cause=${oneLine(record.cause)}` : "") +
        ` ms=${record.endedAt - record.startedAt}`
    );
    this.keep(record);
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch (error) {
        console.error("[turns] a turn-closed listener threw:", error);
      }
    }
    // Last: until its listeners have taken it, the turn stays journaled.
    this.saveJournal();
  }

  private saveJournal(): void {
    const file = this.options.journal?.();
    if (file == null) return;
    const entries: JournalEntry[] = [...this.open].map(([sessionId, turn]) => ({
      sessionId,
      turnId: turn.turnId,
      startedAt: turn.startedAt,
      ...(turn.channel != null ? { channel: turn.channel } : {}),
    }));
    try {
      writeFileAtomicSync(file, JSON.stringify(entries));
    } catch (error) {
      console.error("[turns] could not journal the open turns:", error);
    }
  }

  private fileOf(sessionId: string): string | null {
    const dir = this.options.dir?.();
    if (dir == null || !/^[\w-]+$/.test(sessionId)) return null;
    return path.join(dir, `${sessionId}.json`);
  }

  /** Kept without the error or the chat: the kind and cause are what is uploaded. */
  private keep({
    error: _error,
    channel: _channel,
    ...record
  }: TurnRecord): void {
    const file = this.fileOf(record.sessionId);
    if (file == null) return;
    try {
      // By turnId: a close replayed after a crash is kept once.
      const kept = [
        ...this.records(record.sessionId).filter(
          (earlier) => earlier.turnId !== record.turnId
        ),
        record,
      ].slice(-RECORDS_KEPT);
      writeFileAtomicSync(file, JSON.stringify(kept));
    } catch (error) {
      console.error("[turns] could not keep a turn record:", error);
    }
  }
}

const oneLine = (text: string): string =>
  text.replace(/\s+/g, " ").trim().slice(0, 120);
