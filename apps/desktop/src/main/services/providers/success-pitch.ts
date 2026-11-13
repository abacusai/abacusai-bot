/**
 * The success pitch (contract success-pitch.ts), main's side. It reads each
 * turn's events while it runs and acts on the turn's one ending (TurnLedger):
 *
 * - a result that handed over a site or a file, or a short positive reaction
 *   to a reply that was a result (a message, a thumbs-up, a praise emoji),
 *   on a free account under half its free grant, stamps an offer in the
 *   prefs row for the session's latest reply; the renderer shows the card;
 * - the user's next message in that session ends the offer, and a complaint
 *   is logged as withdrawing it;
 * - a user who works mainly from their own chat app hears it there once ever,
 *   after a positive reaction, never in a contact's chat.
 *
 * On an install with the next step (next-step.ts), a result ends on that
 * instead, and the card comes only with praise.
 *
 * Two more offers come from the same clean turn, in the app only, ahead of
 * the others: a turn that left something meant to stay on (a server or bot
 * started in the background, a routine) offers to keep it running 24/7,
 * once per thing; a chat that has written enough files offers the plan for
 * its big build, once per chat. A tool that failed along the way does not
 * hold either back: a long build has some.
 *
 * Never on a routine, a host lane, a turn the app opened itself (a bot's
 * first-run note, a routine's fire), or a turn that showed another card.
 * On every plan, a clean turn also marks whether the chat's latest result
 * is something to keep on, for its deploy steps (site-deploy.ts).
 */
import path from "node:path";

import { visibleUserText } from "@abacus-ai/agent/user-text";
import type {
  DesktopEvent,
  UserTextTags,
} from "@abacus-ai/contract/agent-types";
import { isSuggestTasksTool } from "@abacus-ai/contract/bots/suggested-tasks";
import type { PrefsPatch, PrefsRow } from "@abacus-ai/contract/contract/rows";
import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { creditAccountKey } from "@abacus-ai/contract/credit-thresholds";
import { isDeliverableUrl } from "@abacus-ai/contract/deliverables";
import type { FunnelStep } from "@abacus-ai/contract/funnel";
import { abacusPlanTier } from "@abacus-ai/contract/models";
import { keepSiteMarks } from "@abacus-ai/contract/site-deploy";
import {
  commandFolder,
  EMPTY_SUCCESS_PITCH_MARK,
  isBigBuild,
  isLongRunningCommand,
  KEEP_RUNNING_CAPS,
  type KeepKind,
  keepThingKey,
  pitchCaps,
  rememberOffered,
  isCleanReply,
  isComplaint,
  isPositiveReaction,
  mainlyInChatApps,
  type SuccessPitchLead,
  type SuccessPitchMark,
  type SuccessPitchMoment,
  type SuccessPitchOffer,
  successPitchAllowed,
  type SuccessPitchTrigger,
  underHalfOfFreeCredits,
} from "@abacus-ai/contract/success-pitch";

import { previewDirectory } from "../agent-tools/served-previews";
import { handedOverArtifacts } from "../session/session-artifacts.utils";
import type { TurnRecord } from "../session/turn-ledger";

/** What a result handed over. */
type Delivered = "site" | "file";

/** What one open turn did, read off its events. */
interface TurnFacts {
  /** The user's own words opened it (not the app's note, not a routine). */
  byUser: boolean;
  /** More than one message joined it: a steer is not a reaction. */
  messages: number;
  praise: boolean;
  delivered: Delivered | null;
  /** The folder of the site it built, when known. */
  siteDir: string | null;
  lead: SuccessPitchLead | null;
  /** Settled tool calls that went through. */
  tools: number;
  /**
   * An error, an error notice, another card in the turn, or a reply from the
   * free models chosen at the credit wall.
   */
  troubled: boolean;
  /** A tool call failed or was refused. */
  failed: boolean;
  /** The text since the turn's last tool call: its final reply. */
  reply: string;
  /** The first task of the next step the turn ended on (`after_result`), if any. */
  nextTask: string | null;
  /** Files it wrote or edited, by full path. */
  files: Set<string>;
  /** Something it left on that is not a site: a server or a routine. */
  keep: Keep | null;
}

/** Something a turn left on, to keep running. */
interface Keep {
  kind: KeepKind;
  /** Its folder; null for a routine. */
  dir: string | null;
  name: string | null;
}

/** Chats whose totals are kept: the most recent ones. */
const CHATS_KEPT = 50;

/** One offer the turn could make, in order of preference. */
interface Signal {
  trigger: SuccessPitchTrigger;
  moment: SuccessPitchMoment;
  lead: SuccessPitchLead | null;
  name?: string | null;
  detail?: string | null;
  /** Remembered as offered, so it comes once: the chat, or the thing. */
  once?: { list: "bigTaskChats" | "keepOffered"; item: string };
}

/** A session's last closed reply, which a reaction can point at. */
interface LastReply {
  turnId: string;
  clean: boolean;
  lead: SuccessPitchLead | null;
}

export interface SuccessPitchDeps {
  prefs: () => { get(): PrefsRow; update(patch: PrefsPatch): unknown } | null;
  /** The account as last read; null when unknown. */
  account: () => AbacusAccountInfo | null;
  /** False for a routine's session or a host lane's: never pitched. */
  pitchable: (sessionId: string) => boolean;
  /** The session's workspace folder, to resolve a deliverable's path. */
  workspacePath: (sessionId: string) => string | null;
  /** A turn is still running in the session. */
  turnOpen: (sessionId: string) => boolean;
  /** The pitch in the user's own chat app, right after `sessionId`'s turn there; whether it went. */
  tellInChat: (sessionId: string) => Promise<boolean>;
  funnel: (step: FunnelStep, detail: string) => void;
  /** Results end on a next step, which takes the card's place (off on the hosted computer). */
  nextStep: () => boolean;
  /**
   * A turn the user's own words opened ended, in any chat: a result handed
   * over (with the next step it ended on and the reply offering it), a
   * question for them, a stop partway, or a plain reply.
   */
  turnEnded?: (
    sessionId: string,
    ending: TurnEnding,
    task: string | null,
    reply: string | null
  ) => void;
  /** Someone's own words reached `sessionId` (any chat). */
  userWrote?: (sessionId: string) => void;
  now?: () => number;
}

/** How a turn the user opened ended, for "your work is waiting" (work-waiting.ts). */
export type TurnEnding = Delivered | "question" | "unfinished" | "chat";

/** A reply that ends asking the user something (any script's question mark). */
const ASKS = /[?？؟\u037e]\s*$/u;

/** Tools that are another card of their own: the pitch never stacks on them. */
const CARD_TOOLS = ["paid_feature", "offer_session"];

/** The first task of a next step that is more work, not a routine. */
const firstWorkTask = (tasks: unknown): string | null => {
  if (!Array.isArray(tasks)) return null;
  for (const task of tasks as { text?: unknown; routine?: unknown }[])
    if (
      task?.routine !== true &&
      typeof task?.text === "string" &&
      task.text.trim().length > 0
    )
      return task.text.trim();
  return null;
};

/** `tool`, under its MCP server's prefix (`agent-tools_serve`) or bare. */
const isTool = (name: string, tool: string): boolean =>
  name === tool || name.endsWith(`_${tool}`);

/** Mail work: the user's inbox, drafts, sends. */
const MAIL_TOOL = /gmail|outlook|e-?mail|inbox|mail_/i;
/** Image and video work. */
const MEDIA_TOOL = /image|flux|video/i;

const HTML_FILE = /\.html?$/i;

/** Tools that write or change a file at `path`. */
const FILE_TOOLS = ["write", "edit", "batch_edit"];

/** A routine's name when the create gave none: the prompt's opening words. */
const ROUTINE_NAME_WORDS = 6;

export class SuccessPitchWatch {
  private readonly turns = new Map<string, TurnFacts>();
  private readonly lastReply = new Map<string, LastReply>();
  /** Per chat: the files it has written so far, for the big-build card. */
  private readonly chats = new Map<string, Set<string>>();

  constructor(private readonly deps: SuccessPitchDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private facts(sessionId: string): TurnFacts {
    let facts = this.turns.get(sessionId);
    if (facts == null) {
      facts = {
        byUser: false,
        messages: 0,
        praise: false,
        delivered: null,
        siteDir: null,
        lead: null,
        tools: 0,
        troubled: false,
        failed: false,
        reply: "",
        nextTask: null,
        files: new Set(),
        keep: null,
      };
      this.turns.set(sessionId, facts);
    }
    return facts;
  }

  /**
   * A message the agent accepted for `sessionId`. Its own words decide what
   * the turn is; the next message also ends the offer standing there.
   */
  userSaid(sessionId: string, text: string, tags?: UserTextTags): void {
    const words = visibleUserText(text, tags);
    const facts = this.facts(sessionId);
    facts.messages += 1;
    if (facts.messages === 1) {
      facts.byUser = words.length > 0;
      facts.praise = facts.byUser && isPositiveReaction(words);
    } else facts.praise = false;
    if (words.length > 0) {
      this.endOffer(sessionId, isComplaint(words));
      this.deps.userWrote?.(sessionId);
    }
  }

  /** One of the session's agent events, while its turn runs. */
  observe(sessionId: string, payload: DesktopEvent): void {
    if (payload.type !== "event") return;
    const event = payload.event;
    switch (event.type) {
      case "text_delta":
        this.facts(sessionId).reply += event.content;
        return;
      case "tool_call_start":
        if (!isSuggestTasksTool(event.toolName))
          this.facts(sessionId).reply = "";
        return;
      case "error":
        this.facts(sessionId).troubled = true;
        return;
      case "turn_complete":
        if (event.usage?.lane === "free") this.facts(sessionId).troubled = true;
        return;
      case "notification":
        if (
          event.severity === "error" ||
          event.severity === "warning" ||
          (event.actions?.length ?? 0) > 0
        )
          this.facts(sessionId).troubled = true;
        return;
      case "tool_execution_complete":
        this.toolSettled(sessionId, payload, event);
        return;
      default:
        return;
    }
  }

  private toolSettled(
    sessionId: string,
    payload: DesktopEvent,
    event: Extract<
      Extract<DesktopEvent, { type: "event" }>["event"],
      { type: "tool_execution_complete" }
    >
  ): void {
    const facts = this.facts(sessionId);
    const name = event.tool.name;
    // The reply stands: suggest_tasks comes after it and can end the turn.
    if (!isSuggestTasksTool(name)) facts.reply = "";
    else if (event.tool.input.after_result === true)
      facts.nextTask = firstWorkTask(event.tool.input.tasks);
    if (event.result.rejected === true) {
      facts.failed = true;
      return;
    }
    if (CARD_TOOLS.some((tool) => isTool(name, tool))) facts.troubled = true;
    facts.tools += 1;
    if (MAIL_TOOL.test(name)) facts.lead ??= "agents";
    if (MEDIA_TOOL.test(name)) facts.lead = "media";
    const input = event.tool.input;
    const workspace = this.deps.workspacePath(sessionId);
    const resolve = (where: string): string | null =>
      path.isAbsolute(where)
        ? where
        : workspace != null
          ? path.resolve(workspace, where)
          : null;
    if (
      FILE_TOOLS.some((tool) => isTool(name, tool)) &&
      typeof input.path === "string" &&
      input.path.trim().length > 0
    ) {
      const file = resolve(input.path.trim());
      if (file != null) facts.files.add(file);
      return;
    }
    if (
      isTool(name, "bash") &&
      input.background === true &&
      typeof input.command === "string" &&
      isLongRunningCommand(input.command)
    ) {
      const folder = commandFolder(input.command);
      const dir = folder != null ? resolve(folder) : workspace;
      facts.keep = {
        kind: "server",
        dir,
        name: dir != null ? path.basename(dir) : null,
      };
      return;
    }
    if (
      isTool(name, "cronjob") &&
      input.action === "create" &&
      event.result.content.startsWith("Created.")
    ) {
      const named = String(input.name ?? "").trim();
      const prompt = String(input.prompt ?? "").trim();
      facts.keep = {
        kind: "routine",
        dir: null,
        name:
          named.length > 0
            ? named
            : prompt.length > 0
              ? prompt.split(/\s+/).slice(0, ROUTINE_NAME_WORDS).join(" ")
              : null,
      };
      return;
    }
    if (isTool(name, "serve") && input.action === "start") {
      facts.delivered = "site";
      const directory = String(input.directory ?? "").trim();
      if (directory.length > 0) facts.siteDir = resolve(directory);
      return;
    }
    for (const draft of handedOverArtifacts(payload, workspace)) {
      const site =
        (draft.kind === "link" && isDeliverableUrl(draft.location)) ||
        HTML_FILE.test(draft.location);
      if (site) {
        facts.delivered = "site";
        facts.siteDir ??=
          draft.kind === "link"
            ? previewDirectory(draft.location)
            : path.dirname(draft.location);
      } else facts.delivered ??= "file";
      if (draft.kind === "image") facts.lead = "media";
    }
  }

  /** A turn closed (TurnLedger), once: the pitch is decided here. */
  turnClosed(record: TurnRecord): Promise<void> {
    const facts = this.turns.get(record.sessionId) ?? null;
    this.turns.delete(record.sessionId);
    const files = facts != null ? this.addUp(record.sessionId, facts) : 0;
    const previous = this.lastReply.get(record.sessionId) ?? null;
    this.lastReply.delete(record.sessionId);
    if (facts?.byUser === true) this.tellTurnEnded(record, facts);
    if (
      record.kind !== "reply" ||
      facts == null ||
      !facts.byUser ||
      !this.deps.pitchable(record.sessionId)
    )
      return Promise.resolve();
    // The turn did work, untroubled, and the reply does not say it failed;
    // a result also had no tool fail along the way.
    const settled =
      facts.tools > 0 && !facts.troubled && isCleanReply(facts.reply);
    const clean = settled && !facts.failed;
    // A site leads with apps; otherwise what the turn worked on, if anything.
    const lead = facts.delivered === "site" ? "apps" : facts.lead;
    this.lastReply.set(record.sessionId, {
      turnId: record.turnId,
      clean,
      lead,
    });
    // A contact's chat is never pitched, nor counted.
    const where =
      record.channel == null ? "app" : record.channel.owner ? "chat" : null;
    if (where == null) return Promise.resolve();
    if (settled)
      this.markKeep(record.sessionId, record.turnId, this.keepOf(facts));
    const nextStep = this.deps.nextStep();
    if (clean && facts.delivered != null)
      this.deps.funnel("result_delivered", facts.delivered);
    const signals: Signal[] = [];
    if (settled && where === "app") {
      // A served site is mostly a preview: only a server or a routine is offered.
      const keep = facts.keep;
      if (keep != null)
        signals.push({
          trigger: "keep_running",
          moment: keep.kind,
          lead: "agents",
          name: keep.name,
          once: {
            list: "keepOffered",
            item: keepThingKey(keep.kind, keep.dir ?? keep.name),
          },
        });
      if (isBigBuild(files))
        signals.push({
          trigger: "big_task",
          moment: "big_task",
          lead: "apps",
          detail: String(files),
          once: { list: "bigTaskChats", item: record.sessionId },
        });
    }
    if (clean && facts.delivered != null && !nextStep)
      signals.push({ trigger: "deliverable", moment: facts.delivered, lead });
    else if (facts.praise && previous?.clean === true)
      signals.push({
        trigger: "positive_reaction",
        moment: "reaction",
        lead: previous.lead ?? facts.lead,
      });
    return this.decide(record.sessionId, where, signals, record.turnId);
  }

  /** The distinct files the chat has written so far, with this turn's added. */
  private addUp(sessionId: string, facts: TurnFacts): number {
    const files = this.chats.get(sessionId) ?? new Set<string>();
    for (const file of facts.files) files.add(file);
    // Most recent last, so the oldest chat is the first to go.
    this.chats.delete(sessionId);
    this.chats.set(sessionId, files);
    for (const old of this.chats.keys()) {
      if (this.chats.size <= CHATS_KEPT) break;
      this.chats.delete(old);
    }
    return files.size;
  }

  /** What a turn left on, for the deploy steps: a server or routine it started, else the site it served. */
  private keepOf(facts: TurnFacts): Keep | null {
    if (facts.keep != null) return facts.keep;
    if (facts.delivered !== "site") return null;
    return {
      kind: "site",
      dir: facts.siteDir,
      name: facts.siteDir != null ? path.basename(facts.siteDir) : null,
    };
  }

  /**
   * Whether a routine created now in `sessionId` gets the "keep it running"
   * card when the turn closes: then the create's once-per-user line about
   * running with the computer off is not said too.
   */
  keepCardFor(sessionId: string): boolean {
    if (!this.deps.pitchable(sessionId)) return false;
    const account = this.deps.account();
    if (account == null) return false;
    const tier = abacusPlanTier(account);
    if (tier !== "free") return tier !== "unknown";
    const key = creditAccountKey(account);
    const prefs = this.deps.prefs();
    if (key == null || prefs == null) return false;
    return (
      underHalfOfFreeCredits(account.credits_used, account.credits_granted) &&
      successPitchAllowed(
        prefs.get().dismissals.keepRunningCards?.[key],
        undefined,
        this.now(),
        KEEP_RUNNING_CAPS
      )
    );
  }

  /** How the user's turn ended, in any chat: what "your work is waiting" says about it. */
  private tellTurnEnded(record: TurnRecord, facts: TurnFacts): void {
    const clean =
      record.kind === "reply" &&
      facts.tools > 0 &&
      !facts.troubled &&
      !facts.failed &&
      isCleanReply(facts.reply);
    const ending: TurnEnding =
      clean && facts.delivered != null
        ? facts.delivered
        : record.kind !== "reply" || (facts.tools > 0 && !clean)
          ? "unfinished"
          : ASKS.test(facts.reply.trim())
            ? "question"
            : "chat";
    const task = clean && facts.delivered != null ? facts.nextTask : null;
    this.deps.turnEnded?.(
      record.sessionId,
      ending,
      task,
      task == null ? null : facts.reply
    );
  }

  /**
   * The session's latest finished turn, for the deploy steps on any plan:
   * something left on keeps its mark; any other clean result clears it.
   */
  private markKeep(sessionId: string, turnId: string, keep: Keep | null): void {
    const prefs = this.deps.prefs();
    if (prefs == null) return;
    const { [sessionId]: had, ...others } = prefs.get().siteReady ?? {};
    if (keep == null) {
      if (had != null) prefs.update({ siteReady: others });
      return;
    }
    prefs.update({
      siteReady: keepSiteMarks({
        ...others,
        [sessionId]: {
          turnId,
          siteDir: keep.dir,
          at: this.now(),
          kind: keep.kind,
          name: keep.name,
        },
      }),
    });
  }

  /**
   * A thumbs-up or a praise emoji on the session's latest reply. Only between
   * turns, and only for a reply that was a result.
   */
  reacted(sessionId: string): Promise<void> {
    const previous = this.lastReply.get(sessionId);
    if (
      previous == null ||
      !previous.clean ||
      this.deps.turnOpen(sessionId) ||
      !this.deps.pitchable(sessionId)
    )
      return Promise.resolve();
    return this.decide(
      sessionId,
      "app",
      [
        {
          trigger: "positive_reaction",
          moment: "reaction",
          lead: previous.lead,
        },
      ],
      `${previous.turnId}:reaction`,
      false
    );
  }

  /** Offers the first of `signals` that is allowed now, if any. */
  private async decide(
    sessionId: string,
    where: "app" | "chat",
    signals: readonly Signal[],
    offerId: string,
    countTurn = true
  ): Promise<void> {
    const account = this.deps.account();
    // Free only: a paid, trial or unread plan is never pitched.
    if (account == null || abacusPlanTier(account) !== "free") return;
    const key = creditAccountKey(account);
    const prefs = this.deps.prefs();
    if (key == null || prefs == null) return;
    // Past half the grant, the credit milestone cards own the pitch.
    if (!underHalfOfFreeCredits(account.credits_used, account.credits_granted))
      return;
    const row = prefs.get();
    const marks = row.successPitch ?? {};
    let mark: SuccessPitchMark = marks[key] ?? EMPTY_SUCCESS_PITCH_MARK;
    if (countTurn)
      mark =
        where === "app"
          ? { ...mark, appTurns: mark.appTurns + 1 }
          : { ...mark, chatTurns: mark.chatTurns + 1 };
    const now = this.now();
    const write = (next: SuccessPitchMark) =>
      prefs.update({
        successPitch: { ...prefs.get().successPitch, [key]: next },
      });
    const signal =
      signals.find((each) => {
        if (each.once != null && mark[each.once.list]?.includes(each.once.item))
          return false;
        return each.trigger === "keep_running"
          ? successPitchAllowed(
              row.dismissals.keepRunningCards?.[key],
              undefined,
              now,
              pitchCaps(each.trigger)
            )
          : successPitchAllowed(
              row.dismissals.successPitchCards?.[key],
              mark,
              now
            );
      }) ?? null;
    if (signal == null) {
      if (countTurn) write(mark);
      return;
    }
    if (where === "app") {
      const { once, ...shown } = signal;
      const offer: SuccessPitchOffer = {
        id: offerId,
        sessionId,
        ...shown,
        at: now,
      };
      write({
        ...mark,
        offer,
        ...(once != null
          ? { [once.list]: rememberOffered(mark[once.list], once.item) }
          : {}),
      });
      return;
    }
    // A chat app hears it once ever, after praise, from a chat-first user.
    if (
      signal.trigger !== "positive_reaction" ||
      mark.chatToldAt != null ||
      !mainlyInChatApps(mark)
    ) {
      write(mark);
      return;
    }
    write({ ...mark, chatToldAt: now });
    const told = await this.deps.tellInChat(sessionId);
    if (told) this.deps.funnel("success_pitch_chat_told", signal.trigger);
    else write({ ...mark, chatToldAt: null });
  }

  /** A complaint right after the card, logged under its own trigger's events. */
  private withdrawn(offer: SuccessPitchOffer): void {
    if (offer.trigger === "big_task")
      this.deps.funnel("big_task_withdrawn", offer.detail ?? "files");
    else if (offer.trigger === "keep_running")
      this.deps.funnel("keep_running_withdrawn", offer.moment);
    else this.deps.funnel("success_pitch_withdrawn", offer.trigger);
  }

  /** The user moved on in `sessionId`: its offer ends; a complaint withdraws it. */
  private endOffer(sessionId: string, complaint: boolean): void {
    const prefs = this.deps.prefs();
    if (prefs == null) return;
    const marks = prefs.get().successPitch ?? {};
    for (const [key, mark] of Object.entries(marks)) {
      if (mark.offer?.sessionId !== sessionId) continue;
      if (complaint) this.withdrawn(mark.offer);
      prefs.update({
        successPitch: { ...marks, [key]: { ...mark, offer: null } },
      });
      return;
    }
  }
}

/**
 * The agent-event listener that feeds the watch: every event of a running
 * turn. The turn's end is the ledger's, never read here.
 */
export const successPitchListener =
  (watch: Pick<SuccessPitchWatch, "observe">) =>
  (sessionId: string, payload: DesktopEvent): void => {
    try {
      watch.observe(sessionId, payload);
    } catch (error) {
      console.warn(`[success-pitch] reading an event failed: ${String(error)}`);
    }
  };
