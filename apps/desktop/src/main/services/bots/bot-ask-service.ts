/**
 * Requests between bots as background work, the way a personal agent hands
 * a task to a DeepAgent run or a coding agent starts a background sub-agent.
 * Two kinds, both recorded and returned from at once, both told to the asker
 * later as a hidden note (BotAskDeps.tell) between the user's turns:
 * - an ask (`ask_bot`): the bot's own question, answered by the other bot in
 *   its locked-down conversation with the asker;
 * - a task (`give_task_to_bot`): the user's instruction, passed on to the
 *   other bot's own chat, where it works with its normal tools.
 *
 * Every request is a record in `~/.abacusai-bot/bot-asks.json`, so the asker
 * can always see what it is waiting on (check_bot_answers), an answer the
 * note never delivered can still be read, and one the app closed on runs
 * again at the next start. Requests that share a conversation run one at a
 * time (a send into a running turn would join it): asks per pair of bots,
 * tasks per bot doing them.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";
import type { Bot } from "@abacus-ai/contract/bots";

import { abacusBotHome } from "../../paths";
import {
  answerWords,
  askOutcomeNote,
  type BotAskKind,
  botAskIntro,
  botTaskPrompt,
  frameBotRequest,
  ownChatContext,
  requestNotes,
  MAX_REQUESTS_PER_DAY,
} from "./bot-ask";

export type BotAskStatus =
  | "queued"
  | "running"
  | "answered"
  | "failed"
  | "cancelled";

export interface BotAskRecord {
  id: string;
  askerId: string;
  /** An ask (the bot's own question) or a task (the user's instruction); absent is an ask. */
  kind?: BotAskKind;
  /** For a task: what the user said, verbatim, which gives it authority. */
  userWords?: string;
  /** The asker's conversation: where the outcome note goes. */
  askerSession: string;
  /**
   * The user's own chat on an app (WhatsApp, Telegram…) the request was made
   * from, so the answer goes back there rather than to the app's chat.
   */
  channel?: { platform: string; chatId: string };
  targetId: string;
  request: string;
  status: BotAskStatus;
  /** The asked bot's words, as answerWords keeps them ("" for none). */
  answer?: string;
  error?: string;
  /** Turns started for it; one cut off by a restart runs once more. */
  attempts: number;
  createdAt: number;
  endedAt?: number;
}

type AskBot = Pick<Bot, "id" | "name" | "title">;

export interface BotAskDeps {
  bot: (id: string) => AskBot | null;
  /**
   * Run one turn of the asked bot in its conversation with the asker and
   * resolve with that turn's raw text; reject when it fails or runs too long
   * (the host stops it then). An ask runs in the asked bot's conversation
   * with the asker, a task in its own chat; `visibleFrom` is where the
   * request starts after the rules (null: all of it shows).
   */
  runTurn: (
    ask: BotAskRecord,
    prompt: string,
    visibleFrom: number | null
  ) => Promise<string>;
  /** Stop the asked bot's turn for this ask, if it is running. */
  stopTurn: (ask: BotAskRecord) => void;
  /**
   * The asker hears the note as a hidden turn between the user's turns, in
   * the chat the request came from (`ask.channel`, else the app's).
   */
  tell: (ask: BotAskRecord, note: string) => void;
  read: () => BotAskRecord[];
  write: (records: BotAskRecord[]) => void;
  /** A request was made: the asker's follow-up tools appear (re-list). */
  changed?: () => void;
  /** A line for a bot's daily notes: what it asked, passed on, answered or did. */
  note?: (botId: string, line: string) => void;
  /** The user's latest lines in a bot's own chat, for an ask's context. */
  ownChatLines?: (botId: string) => string[];
  /** One line per request event, no message text: for the app's log. */
  log?: (line: string) => void;
  now?: () => number;
  newId?: () => string;
}

/** Finished asks kept for check_bot_answers; open ones are always kept. */
const KEPT_FINISHED = 200;
const DAY_MS = 24 * 60 * 60_000;
const OPEN: readonly BotAskStatus[] = ["queued", "running"];

export const isOpenAsk = (ask: BotAskRecord): boolean =>
  OPEN.includes(ask.status);

/**
 * The conversation a request runs in, so those sharing one go one at a
 * time: an ask, the two bots' own; a task, the doing bot's own chat.
 */
const laneOf = (ask: BotAskRecord): string =>
  ask.kind === "task"
    ? `${ask.targetId}|main`
    : `${ask.targetId}|${ask.askerId}`;

/** The asks file, read fresh each time: one process writes it. */
export const fileAskStore = (): Pick<BotAskDeps, "read" | "write"> => {
  const file = (): string => path.join(abacusBotHome(), "bot-asks.json");
  return {
    read: () => {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file(), "utf8"));
        return Array.isArray(parsed) ? (parsed as BotAskRecord[]) : [];
      } catch {
        return [];
      }
    },
    write: (records) =>
      writeFileAtomicSync(file(), JSON.stringify(records, null, 2)),
  };
};

export class BotAskService {
  /** Conversations (laneOf) with a request's turn running in this process. */
  private readonly running = new Set<string>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: BotAskDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => randomBytes(3).toString("hex"));
  }

  /**
   * Record a request and start it, or queue it behind the open ones in the
   * same conversation; `behind` is how many go first. A task needs the
   * user's own words (`userWords`). `channel`: the user's own chat on an app
   * the request came from, where its outcome goes back.
   */
  ask(
    askerId: string,
    askerSession: string,
    targetId: string,
    request: string,
    options: {
      kind?: BotAskKind;
      userWords?: string;
      channel?: { platform: string; chatId: string } | null;
    } = {}
  ): { ask: BotAskRecord; behind: number } | { error: string } {
    const now = this.now();
    const mine = this.deps.read().filter((ask) => ask.askerId === askerId);
    const { kind = "ask", userWords, channel } = options;
    // The same request to the same bot while it is still open: once is enough.
    const same = (text: string): string =>
      text.toLowerCase().replace(/\s+/g, " ").trim();
    const duplicate = mine.find(
      (ask) =>
        isOpenAsk(ask) &&
        ask.targetId === targetId &&
        (ask.kind ?? "ask") === kind &&
        same(ask.request) === same(request)
    );
    if (duplicate != null)
      return {
        error: `You already sent that (request ${duplicate.id}), and it is still open. Its answer will come as a note; do not send it again.`,
      };
    if (
      mine.filter((ask) => now - ask.createdAt < DAY_MS).length >=
      MAX_REQUESTS_PER_DAY
    )
      return {
        error: `You have sent other bots ${MAX_REQUESTS_PER_DAY} requests today, far more than usual, so no more go out today. Tell the user.`,
      };
    const ask: BotAskRecord = {
      id: this.newId(),
      ...(kind === "task" ? { kind, userWords: userWords ?? request } : {}),
      askerId,
      askerSession,
      ...(channel != null
        ? { channel: { platform: channel.platform, chatId: channel.chatId } }
        : {}),
      targetId,
      request,
      status: "queued",
      attempts: 0,
      createdAt: now,
    };
    const behind = this.deps
      .read()
      .filter((each) => isOpenAsk(each) && laneOf(each) === laneOf(ask)).length;
    this.save([...this.deps.read(), ask]);
    this.logLine(ask, "queued");
    this.deps.changed?.();
    this.pump(laneOf(ask));
    return { ask, behind };
  }

  /** This bot's asks, newest first. */
  list(askerId: string, limit = 10): BotAskRecord[] {
    return this.deps
      .read()
      .filter((ask) => ask.askerId === askerId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  get(askerId: string, id: string): BotAskRecord | null {
    return (
      this.deps
        .read()
        .find((ask) => ask.askerId === askerId && ask.id === id.trim()) ?? null
    );
  }

  /** Cancel one of this bot's open asks; the asked bot's turn stops. */
  cancel(askerId: string, id: string): { ok: string } | { error: string } {
    const ask = this.get(askerId, id);
    if (ask == null) return { error: `You have no request ${id.trim()}.` };
    if (!isOpenAsk(ask))
      return { error: `Request ${ask.id} is already ${ask.status}.` };
    this.patch(ask.id, { status: "cancelled", endedAt: this.now() });
    this.logLine(ask, "cancelled");
    if (ask.status === "running") this.deps.stopTurn(ask);
    return { ok: `Cancelled request ${ask.id}. No answer will come for it.` };
  }

  /**
   * At start: an ask the app closed on runs once more (its turn died with
   * the app), one that already did fails and says so; a task the app closed
   * on fails and says so (it may be half done); queued requests start.
   */
  recover(): void {
    for (const ask of this.deps
      .read()
      .filter((ask) => ask.status === "running")) {
      // A task may have done part of its work (sent, posted, booked): never
      // run twice on its own; the asker checks the other bot's chat first.
      if (ask.kind === "task")
        this.finish(ask.id, {
          error:
            "the app closed while it was working on it, so it may be half done. Ask the user to check its chat before passing it on again.",
        });
      else if (ask.attempts >= 2)
        this.finish(ask.id, {
          error: "the app closed twice before it answered.",
        });
      else this.patch(ask.id, { status: "queued" });
    }
    for (const ask of this.deps.read().filter((ask) => ask.status === "queued"))
      this.pump(laneOf(ask));
  }

  /**
   * A deleted bot's open asks end: ones it made are cancelled without a
   * note (nobody is left to tell); ones made to it fail, and the asker
   * hears why, so it does not wait on an answer that cannot come.
   */
  forgetBot(botId: string): void {
    for (const ask of this.deps.read()) {
      if (!isOpenAsk(ask)) continue;
      if (ask.askerId === botId) {
        this.patch(ask.id, { status: "cancelled", endedAt: this.now() });
        if (ask.status === "running") this.deps.stopTurn(ask);
      } else if (ask.targetId === botId) {
        if (ask.status === "running") this.deps.stopTurn(ask);
        this.finish(ask.id, {
          error: "the user deleted that bot, so it ended there.",
        });
      }
    }
  }

  /** Start the conversation's oldest queued request, unless one is running there. */
  private pump(lane: string): void {
    if (this.running.has(lane)) return;
    const next = this.deps
      .read()
      .filter((ask) => ask.status === "queued" && laneOf(ask) === lane)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (next == null) return;
    const asker = this.deps.bot(next.askerId);
    if (asker == null || this.deps.bot(next.targetId) == null) {
      this.finish(next.id, { error: "that bot was deleted." });
      this.pump(lane);
      return;
    }
    this.running.add(lane);
    const started = {
      ...next,
      status: "running" as const,
      attempts: next.attempts + 1,
    };
    this.patch(next.id, { status: "running", attempts: started.attempts });
    this.logLine(started, "running");
    let prompt: string;
    let visibleFrom: number | null;
    if (next.kind === "task") {
      prompt = botTaskPrompt(
        asker,
        next.request,
        next.userWords ?? next.request
      );
      visibleFrom = null;
    } else {
      const framed = frameBotRequest(asker, next.request);
      const context = ownChatContext(
        this.deps.ownChatLines?.(next.targetId) ?? []
      );
      prompt = `${botAskIntro(asker)}\n\n${context.length > 0 ? `${context}\n\n` : ""}${framed}`;
      visibleFrom = prompt.length - framed.length;
    }
    void this.deps
      .runTurn(started, prompt, visibleFrom)
      .then(
        (raw) => this.finish(next.id, { answer: answerWords(raw) }),
        (error: unknown) =>
          this.finish(next.id, {
            error: error instanceof Error ? error.message : String(error),
          })
      )
      .finally(() => {
        this.running.delete(lane);
        this.pump(lane);
      });
  }

  /** The ask is over: recorded, then told to the asker. */
  private finish(
    id: string,
    outcome: { answer: string } | { error: string }
  ): void {
    const ask = this.deps.read().find((each) => each.id === id);
    // Cancelled (or finished) meanwhile: it stays as it is, and says nothing.
    if (ask == null || !isOpenAsk(ask)) return;
    this.patch(id, {
      ...("answer" in outcome
        ? { status: "answered" as const, answer: outcome.answer }
        : { status: "failed" as const, error: outcome.error }),
      endedAt: this.now(),
    });
    this.logLine(ask, "answer" in outcome ? "answered" : "failed");
    const answerer = this.deps.bot(ask.targetId) ?? {
      name: "The other bot",
      title: "",
    };
    this.deps.tell(
      ask,
      askOutcomeNote(
        { id: ask.id, request: ask.request, kind: ask.kind, ...outcome },
        answerer
      )
    );
    const asker = this.deps.bot(ask.askerId) ?? {
      name: "Another bot",
      title: "",
    };
    const notes = requestNotes(
      { request: ask.request, kind: ask.kind, ...outcome },
      asker,
      answerer
    );
    this.deps.note?.(ask.askerId, notes.asker);
    if (notes.answerer != null) this.deps.note?.(ask.targetId, notes.answerer);
  }

  /** e.g. `[bot-ask] q1 task res->pla answered 42s attempt 1`; never the text. */
  private logLine(ask: BotAskRecord, event: string): void {
    const seconds = Math.round((this.now() - ask.createdAt) / 1000);
    this.deps.log?.(
      `[bot-ask] ${ask.id} ${ask.kind ?? "ask"} ${ask.askerId}->${ask.targetId} ${event} ${seconds}s attempt ${ask.attempts}`
    );
  }

  private patch(id: string, change: Partial<BotAskRecord>): void {
    this.save(
      this.deps
        .read()
        .map((ask) => (ask.id === id ? { ...ask, ...change } : ask))
    );
  }

  /** Every open ask, and the newest finished ones. */
  private save(records: BotAskRecord[]): void {
    const finished = records
      .filter((ask) => !isOpenAsk(ask))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, KEPT_FINISHED);
    const keep = new Set([...records.filter(isOpenAsk), ...finished]);
    this.deps.write(records.filter((ask) => keep.has(ask)));
  }
}
