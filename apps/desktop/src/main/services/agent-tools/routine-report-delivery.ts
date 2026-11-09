/**
 * A local routine run's report is the app's to deliver, as a hosted run's is
 * the server's: the run only writes its final answer. It goes word for word,
 * once per fire (the send ledger), to the chat the routine belongs to (its
 * bot's chat, or the chat it was made from) and to the user's own chat app
 * whose home bot made it, through the gateway's one own-chat send (its
 * outbox holds it through quiet hours or a lane that is down). A delivery is
 * recorded before it is made and replayed at launch, and the chat that got a
 * report hears it on the user's next message there, as a hidden note.
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

/** The send ledger's name for the in-app chat a report was delivered to. */
export const REPORT_CHAT_PLATFORM = "app";

/** A chat app gets the report up to this long; the app keeps all of it. */
export const REPORT_CHAT_APP_MAX_CHARS = 1_500;

/** A held chat-app send this old would land a stale "go?" a day late: dropped. */
export const REPORT_OUTBOX_KEPT_MS = 12 * 60 * 60_000;

/** What a note keeps of a report, and of the reports a chat has pending. */
const NOTE_REPORT_CHARS = 1_500;
const NOTES_SHOWN = 3;
const NOTE_KEPT_MS = 48 * 60 * 60_000;

/** Each lane by the chat app's name, for the run and the note. */
export const REPORT_LANE_NAMES: Record<SelfLanePlatform, string> = {
  whatsapp: "WhatsApp",
  abacus_telegram: "Telegram",
  abacus_discord: "Discord",
};

/** One finished run's report. */
export interface RunReport {
  /** The fire it answers (`routine@slot`): what the ledger keys on. */
  fire: string;
  routineId: string;
  routineName: string;
  runSessionId: string;
  /** When the run started (ISO). */
  startedAt: string;
  text: string;
  /** The run's own file, as the model reads paths. */
  runFile: string | null;
}

export interface RunReportTargets {
  /** The chat session to deliver into, or null (none, or already delivered). */
  chat: string | null;
  /** The user's own chat apps still owed it. */
  lanes: SelfLanePlatform[];
}

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
  /** The self lanes whose home bot made the routine. */
  lanes: readonly SelfLanePlatform[];
  /** What this fire's runs already sent (`ledger.recipients`). */
  sent: ReadonlyArray<{ platform: string; to: string }>;
  /** `to` on `platform` is the user's own chat (the gateway's answer). */
  isOwnChat: (platform: string, to: string) => boolean;
}): RunReportTargets | null => {
  if (input.outcome !== "completed") return null;
  if (isQuietReply(input.reply) || input.reply.trim().length === 0) return null;
  const delivered = input.sent.some(
    (entry) => entry.platform === REPORT_CHAT_PLATFORM
  );
  return {
    chat: delivered ? null : input.chat,
    lanes: input.lanes.filter(
      (lane) =>
        !input.sent.some(
          (entry) =>
            selfLaneOf(entry.platform as MessagingPlatformId) === lane &&
            input.isOwnChat(entry.platform, entry.to)
        )
    ),
  };
};

/**
 * A long report cut to `max`, keeping its end: a report's question is in its
 * last lines. The head up to the last paragraph, else only the tail.
 */
export const reportExcerpt = (text: string, max: number): string => {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const last = trimmed.slice(trimmed.lastIndexOf("\n\n") + 2).trim();
  if (last.length < max * 0.7) {
    const room = max - last.length - 3;
    const head = trimmed.slice(0, room);
    const space = head.lastIndexOf(" ");
    return `${(space > room * 0.6 ? head.slice(0, space) : head).trimEnd()}\n…\n${last}`;
  }
  return `…${trimmed.slice(trimmed.length - (max - 1)).trimStart()}`;
};

/** The report as a chat app gets it: the excerpt, then where the full run is. */
export const chatAppReportText = (text: string, fullRun: string): string =>
  `${reportExcerpt(text, REPORT_CHAT_APP_MAX_CHARS)}\n\n${fullRun}`;

/** Report text cannot close or open the note's hidden block. */
const neutralized = (text: string): string =>
  text.replace(/<(\/?)system_reminder/gi, "<$1system-reminder");

/** A message holding words the user wrote: not a fire, a kickstart or the app's own note. */
export const carriesUserWords = (tags: UserTextTags | undefined): boolean =>
  tags?.routineFire !== true &&
  (tags?.operator == null
    ? tags?.systemReminder !== true
    : tags.operator.visibleFrom != null &&
      tags.operator.kind !== "routine-editor");

interface PendingNote {
  routineId: string;
  routineName: string;
  runSessionId: string;
  startedAt: string;
  addedAt: number;
  text: string;
  runFile: string | null;
  /** The app delivered it here (and on these apps); false: the user opened the chat to answer it. */
  delivered: boolean;
  lanes: SelfLanePlatform[];
}

interface Stored {
  /** Deliveries recorded but not yet made: replayed at launch. */
  pending: RunReport[];
  notes: Record<string, PendingNote[]>;
}

export interface RoutineReportStoreOptions {
  /** Where the store is kept across restarts; null keeps none. */
  file?: (() => string) | null;
  now?: () => number;
}

/** The deliveries in flight and the notes owed to chats, kept on disk. */
export class RoutineReportStore {
  private stored: Stored | null = null;

  constructor(private readonly options: RoutineReportStoreOptions = {}) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private get state(): Stored {
    if (this.stored != null) return this.stored;
    this.stored = { pending: [], notes: {} };
    const file = this.options.file?.();
    if (file == null) return this.stored;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(file, "utf8")
      ) as Partial<Stored>;
      if (Array.isArray(parsed.pending)) this.stored.pending = parsed.pending;
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
      console.error("[routines] could not keep report deliveries:", error);
    }
  }

  /** A delivery about to be made: kept until `finish`, so a crash replays it. */
  begin(report: RunReport): void {
    this.state.pending = [
      ...this.state.pending.filter((entry) => entry.fire !== report.fire),
      report,
    ];
    this.save();
  }

  finish(fire: string): void {
    this.state.pending = this.state.pending.filter(
      (entry) => entry.fire !== fire
    );
    this.save();
  }

  /** Deliveries a closed app left unmade, oldest first. */
  unfinished(): RunReport[] {
    return [...this.state.pending];
  }

  /** Owe the chat a note of this report on the user's next message there. */
  addNote(
    sessionId: string,
    report: Pick<
      RunReport,
      | "routineId"
      | "routineName"
      | "runSessionId"
      | "startedAt"
      | "text"
      | "runFile"
    >,
    delivery: { delivered: boolean; lanes?: SelfLanePlatform[] }
  ): void {
    this.prune();
    const notes = (this.state.notes[sessionId] ?? []).filter(
      (note) => note.runSessionId !== report.runSessionId
    );
    notes.push({
      ...report,
      text: reportExcerpt(report.text, NOTE_REPORT_CHARS),
      addedAt: this.now(),
      delivered: delivery.delivered,
      lanes: delivery.lanes ?? [],
    });
    this.state.notes[sessionId] = notes.slice(-NOTES_SHOWN);
    this.save();
  }

  /**
   * The hidden notes owed to the user's message in `sessionId`, and `taken`
   * to call once that message has gone to the agent: an unsent message
   * leaves them owed.
   */
  notesFor(sessionId: string): { notes: string[]; taken: () => void } {
    this.prune();
    const pending = this.state.notes[sessionId] ?? [];
    return {
      notes: pending.map(reportNote),
      taken: () => {
        const left = (this.state.notes[sessionId] ?? []).filter(
          (note) => !pending.includes(note)
        );
        if (left.length > 0) this.state.notes[sessionId] = left;
        else delete this.state.notes[sessionId];
        this.save();
      },
    };
  }

  /** Notes older than two days are no longer what the user is answering. */
  private prune(): void {
    const now = this.now();
    let changed = false;
    for (const [sessionId, notes] of Object.entries(this.state.notes)) {
      const fresh = notes.filter((note) => now - note.addedAt <= NOTE_KEPT_MS);
      if (fresh.length === notes.length) continue;
      changed = true;
      if (fresh.length > 0) this.state.notes[sessionId] = fresh;
      else delete this.state.notes[sessionId];
    }
    if (changed) this.save();
  }
}

/** The `[routine report sent]` line: what the user is likely answering. */
const reportNote = (note: PendingNote): string => {
  const when = new Date(note.startedAt).toLocaleString();
  const head = note.delivered
    ? `[routine report sent] Your routine "${note.routineName}" (id ${note.routineId}) ran at ${when} and the app delivered its report to the user in ${["this chat", ...note.lanes.map((lane) => REPORT_LANE_NAMES[lane])].join(" and ")}:`
    : `[routine report] The user opened this chat to reply to the report of your routine "${note.routineName}" (id ${note.routineId}) from its run at ${when}:`;
  return (
    `${head} ${neutralized(JSON.stringify(note.text))}. Their message may answer it: if they say go or ` +
    "answer its question, do it here with your own tools; change the routine with the cronjob tool only " +
    "when they ask about the routine itself." +
    (note.runFile != null
      ? ` The full run is in ${neutralized(note.runFile)}.`
      : "")
  );
};
