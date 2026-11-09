/**
 * A local routine run's report is the app's to deliver, as a hosted run's is
 * the server's: the run only writes its final answer. Delivered word for word,
 * once per fire (the send ledger), to the chat the routine belongs to (its
 * bot's chat, or the chat it was made from) and to the user's own chat app
 * whose home bot made it. A chat app that is down, or quiet hours, holds the
 * send in a small outbox until it can go, never past the routine's next
 * report or 12 hours. The chat that got a report hears it on the user's next
 * message there, as a hidden note, so their answer has the run's context.
 */
import fs from "node:fs";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";
import type { UserTextTags } from "@abacus-ai/contract/agent-types";
import type { RoutineRunOutcome } from "@abacus-ai/contract/contracts";
import {
  selfLaneOf,
  type MessagingPlatformId,
  type SelfLanePlatform,
} from "@abacus-ai/contract/messaging";

import { isQuietReply } from "./routine-guards";
import type { RoutineSendLedger } from "./routine-send-ledger";

/** The send ledger's name for the in-app chat a report was delivered to. */
export const REPORT_CHAT_PLATFORM = "app";

/** A chat app gets the report up to this long; the app keeps all of it. */
export const REPORT_CHAT_APP_MAX_CHARS = 1_500;

/** What a chat's card and its note show of a report. */
const REPORT_KEPT_CHARS = 8_000;

/** A held send this old would land a stale "go?" a day late: dropped. */
export const REPORT_OUTBOX_KEPT_MS = 12 * 60 * 60_000;

/** Reports a chat's next message is told about: the newest few, none stale. */
const NOTES_SHOWN = 3;
const NOTE_KEPT_MS = 48 * 60 * 60_000;
const NOTE_REPORT_CHARS = 1_500;

const SELF_NAMES = /^(me|myself|self)$/i;

/** One finished run's report, as delivered. */
export interface RunReport {
  /** The fire it answers (`routine@slot`): what the ledger keys on. */
  fire: string;
  routineId: string;
  routineName: string;
  runSessionId: string;
  /** When the run started (ISO). */
  startedAt: string;
  text: string;
  /** The run's file, for the note (a path as the model reads it). */
  runFile: string | null;
  /** The bot whose routine it is, named on a chat app send by another's lane. */
  from: { botId: string; name: string } | null;
}

export interface ReportLane {
  lane: SelfLanePlatform;
  /** Linked and up right now. */
  live: boolean;
}

export interface RunReportTargets {
  /** The chat session to deliver into, or null (none, or already delivered). */
  chat: string | null;
  /** Chat apps to send to now. */
  send: SelfLanePlatform[];
  /** Chat apps to hold in the outbox (down, or quiet hours). */
  hold: SelfLanePlatform[];
}

/** A send the run (or an earlier run of the fire) already made to the user's own chat on `lane`. */
const sentToSelf = (
  sent: ReadonlyArray<{ platform: string; to: string }>,
  lane: SelfLanePlatform,
  selfChatId: string | null
): boolean =>
  sent.some(
    (entry) =>
      selfLaneOf(entry.platform as MessagingPlatformId) === lane &&
      (SELF_NAMES.test(entry.to.trim()) ||
        (selfChatId != null && entry.to === selfChatId))
  );

/**
 * Where a run's report goes, or null when there is nothing to deliver: a run
 * that failed or was cut off (the run list says so), or one that ended on
 * NO_REPLY or said nothing.
 */
export const runReportTargets = (input: {
  outcome: RoutineRunOutcome;
  reply: string;
  /** The routine's chat: its bot's, or the one it was made from. */
  chat: string | null;
  lanes: readonly ReportLane[];
  /** What this fire's runs already sent (`ledger.recipients`). */
  sent: ReadonlyArray<{ platform: string; to: string }>;
  selfChatId: (lane: SelfLanePlatform) => string | null;
  quiet: boolean;
}): RunReportTargets | null => {
  if (input.outcome !== "completed") return null;
  if (isQuietReply(input.reply) || input.reply.trim().length === 0) return null;
  const delivered = input.sent.some(
    (entry) => entry.platform === REPORT_CHAT_PLATFORM
  );
  const owed = input.lanes.filter(
    ({ lane }) => !sentToSelf(input.sent, lane, input.selfChatId(lane))
  );
  return {
    chat: delivered ? null : input.chat,
    send: owed
      .filter(({ live }) => live && !input.quiet)
      .map(({ lane }) => lane),
    hold: owed
      .filter(({ live }) => !live || input.quiet)
      .map(({ lane }) => lane),
  };
};

/** The report as a chat app gets it: whole up to the cap, else cut at a word. */
export const chatAppReportText = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length <= REPORT_CHAT_APP_MAX_CHARS) return trimmed;
  const cut = trimmed.slice(0, REPORT_CHAT_APP_MAX_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > REPORT_CHAT_APP_MAX_CHARS * 0.8 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

interface HeldSend {
  fire: string;
  routineId: string;
  runSessionId: string;
  lane: SelfLanePlatform;
  text: string;
  from: { botId: string; name: string } | null;
  queuedAt: number;
}

interface PendingNote {
  fire: string;
  routineId: string;
  routineName: string;
  startedAt: string;
  deliveredAt: number;
  text: string;
  runFile: string | null;
  lanes: SelfLanePlatform[];
}

interface Stored {
  outbox: HeldSend[];
  notes: Record<string, PendingNote[]>;
}

export interface RoutineReportDeliveryOptions {
  ledger: RoutineSendLedger;
  /** Sends to the user's own chat on a lane; rejects when it could not go. */
  send: (
    lane: SelfLanePlatform,
    text: string,
    from: { botId: string; name: string } | null
  ) => Promise<void>;
  /** Lanes linked and up right now. */
  liveLanes: () => readonly SelfLanePlatform[];
  /** Quiet hours, now. */
  quiet: () => boolean;
  selfChatId: (lane: SelfLanePlatform) => string | null;
  /** Where the outbox and notes are kept across restarts; null keeps none. */
  file?: (() => string) | null;
  now?: () => number;
}

/** Each lane by the chat app's name, for the run and the note. */
export const REPORT_LANE_NAMES: Record<SelfLanePlatform, string> = {
  whatsapp: "WhatsApp",
  abacus_telegram: "Telegram",
  abacus_discord: "Discord",
};

export class RoutineReportDelivery {
  private stored: Stored | null = null;

  /** Sends in flight per held entry, so a flush and a connect never double one. */
  private readonly sending = new Set<string>();

  constructor(private readonly options: RoutineReportDeliveryOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private get state(): Stored {
    if (this.stored != null) return this.stored;
    this.stored = { outbox: [], notes: {} };
    const file = this.options.file?.();
    if (file == null) return this.stored;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(file, "utf8")
      ) as Partial<Stored>;
      if (Array.isArray(parsed.outbox)) this.stored.outbox = parsed.outbox;
      if (parsed.notes != null && typeof parsed.notes === "object")
        this.stored.notes = parsed.notes;
    } catch {
      // Nothing kept yet.
    }
    return this.stored;
  }

  private save(): void {
    const file = this.options.file?.();
    if (file == null) return;
    try {
      writeFileAtomicSync(file, JSON.stringify(this.state));
    } catch (error) {
      console.error("[routines] could not keep the report outbox:", error);
    }
  }

  /** Deliver one run's report where `targets` says; the chat's card is the host's. */
  async deliver(report: RunReport, targets: RunReportTargets): Promise<void> {
    const at = this.now();
    // A newer report of the same routine replaces any older one still held.
    this.state.outbox = this.state.outbox.filter(
      (held) => held.routineId !== report.routineId
    );
    if (targets.chat != null) {
      this.options.ledger.record(
        report.fire,
        REPORT_CHAT_PLATFORM,
        targets.chat,
        report.runSessionId,
        report.text
      );
      this.addNote(
        targets.chat,
        report,
        [...targets.send, ...targets.hold],
        at
      );
    }
    const text = chatAppReportText(report.text);
    const held = (lane: SelfLanePlatform): HeldSend => ({
      fire: report.fire,
      routineId: report.routineId,
      runSessionId: report.runSessionId,
      lane,
      text,
      from: report.from,
      queuedAt: at,
    });
    this.state.outbox.push(...targets.hold.map(held));
    this.save();
    await Promise.all(targets.send.map((lane) => this.trySend(held(lane))));
  }

  /** Send what the outbox holds that can go now; drop what is too old. */
  async flush(): Promise<void> {
    const now = this.now();
    const before = this.state.outbox.length;
    this.state.outbox = this.state.outbox.filter(
      (held) => now - held.queuedAt <= REPORT_OUTBOX_KEPT_MS
    );
    if (this.state.outbox.length !== before) this.save();
    if (this.state.outbox.length === 0 || this.options.quiet()) return;
    const live = new Set(this.options.liveLanes());
    const due = this.state.outbox.filter((held) => live.has(held.lane));
    if (due.length === 0) return;
    this.state.outbox = this.state.outbox.filter((held) => !due.includes(held));
    this.save();
    await Promise.all(due.map((held) => this.trySend(held)));
  }

  /** One send; a failure goes back in the outbox, a repeat is never made. */
  private async trySend(held: HeldSend): Promise<void> {
    const key = `${held.fire}\u0000${held.lane}`;
    if (this.sending.has(key)) return;
    const already = sentToSelf(
      this.options.ledger.recipients(held.fire),
      held.lane,
      this.options.selfChatId(held.lane)
    );
    if (already) return;
    this.sending.add(key);
    try {
      await this.options.send(held.lane, held.text, held.from);
      this.options.ledger.record(
        held.fire,
        held.lane,
        "me",
        held.runSessionId,
        held.text
      );
    } catch (error) {
      console.warn(
        `[routines] report for ${held.routineId} held for ${held.lane}: ${String(error)}`
      );
      // Unless a newer report of the routine came in meanwhile.
      if (
        !this.state.outbox.some(
          (entry) =>
            entry.routineId === held.routineId && entry.fire !== held.fire
        )
      ) {
        this.state.outbox.push(held);
        this.save();
      }
    } finally {
      this.sending.delete(key);
    }
  }

  /** What the outbox holds, for tests and the log. */
  held(): ReadonlyArray<Pick<HeldSend, "fire" | "lane" | "text">> {
    return this.state.outbox.map(({ fire, lane, text }) => ({
      fire,
      lane,
      text,
    }));
  }

  /** Queue the report for the chat's next user message. */
  addNote(
    sessionId: string,
    report: RunReport,
    lanes: SelfLanePlatform[] = [],
    at: number = this.now()
  ): void {
    const notes = (this.state.notes[sessionId] ?? []).filter(
      (note) => note.fire !== report.fire
    );
    notes.push({
      fire: report.fire,
      routineId: report.routineId,
      routineName: report.routineName,
      startedAt: report.startedAt,
      deliveredAt: at,
      text: report.text.slice(0, REPORT_KEPT_CHARS),
      runFile: report.runFile,
      lanes,
    });
    this.state.notes[sessionId] = notes.slice(-NOTES_SHOWN);
    this.save();
  }

  /**
   * The hidden note for the user's message in `sessionId`, once: the reports
   * delivered there since they last wrote, newest last, none older than 48 h.
   */
  takeNotes(sessionId: string): string[] {
    const pending = this.state.notes[sessionId];
    if (pending == null) return [];
    delete this.state.notes[sessionId];
    this.save();
    const now = this.now();
    return pending
      .filter((note) => now - note.deliveredAt <= NOTE_KEPT_MS)
      .map((note) => reportNote(note));
  }
}

/** A message holding words the user wrote: not a fire, a kickstart or the app's own note. */
export const carriesUserWords = (tags: UserTextTags | undefined): boolean =>
  tags?.routineFire !== true &&
  (tags?.operator == null
    ? tags?.systemReminder !== true
    : tags.operator.visibleFrom != null &&
      tags.operator.kind !== "routine-editor");

/** The `[routine report sent]` line: what the user is likely answering. */
const reportNote = (note: PendingNote): string => {
  const where = [
    "this chat",
    ...note.lanes.map((lane) => REPORT_LANE_NAMES[lane]),
  ].join(" and ");
  const text =
    note.text.length > NOTE_REPORT_CHARS
      ? `${note.text.slice(0, NOTE_REPORT_CHARS)}…`
      : note.text;
  return (
    `[routine report sent] Your routine "${note.routineName}" (id ${note.routineId}) ran at ` +
    `${new Date(note.startedAt).toLocaleString()} and the app delivered its report to the user in ${where}: ` +
    `${JSON.stringify(text)}. Their message may answer it: if they say go or answer its question, do it here ` +
    "with your own tools; change the routine with the cronjob tool only when they ask about the routine itself." +
    (note.runFile != null ? ` The full run is in ${note.runFile}.` : "")
  );
};
