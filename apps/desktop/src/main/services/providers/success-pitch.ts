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
 * Never on a routine, a host lane, a turn the app opened itself (a bot's
 * first-run note, a routine's fire), or a turn that showed another card.
 */
import { visibleUserText } from "@abacus-ai/agent/user-text";
import type {
  DesktopEvent,
  UserTextTags,
} from "@abacus-ai/contract/agent-types";
import type { PrefsPatch, PrefsRow } from "@abacus-ai/contract/contract/rows";
import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { creditAccountKey } from "@abacus-ai/contract/credit-thresholds";
import { isDeliverableUrl } from "@abacus-ai/contract/deliverables";
import type { FunnelStep } from "@abacus-ai/contract/funnel";
import { abacusPlanTier } from "@abacus-ai/contract/models";
import {
  EMPTY_SUCCESS_PITCH_MARK,
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

import { handedOverArtifacts } from "../session/session-artifacts.utils";
import type { TurnRecord } from "../session/turn-ledger";

/** What one open turn did, read off its events. */
interface TurnFacts {
  /** The user's own words opened it (not the app's note, not a routine). */
  byUser: boolean;
  /** More than one message joined it: a steer is not a reaction. */
  messages: number;
  praise: boolean;
  delivered: Exclude<SuccessPitchMoment, "reaction"> | null;
  lead: SuccessPitchLead | null;
  /** Settled tool calls that went through. */
  tools: number;
  /**
   * An error, a failed tool, an error notice, another card in the turn, or a
   * reply from the free models chosen at the credit wall.
   */
  troubled: boolean;
  /** The text since the turn's last tool call: its final reply. */
  reply: string;
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
  now?: () => number;
}

/** Tools that are another card of their own: the pitch never stacks on them. */
const CARD_TOOLS = ["paid_feature", "offer_session"];

/** `tool`, under its MCP server's prefix (`agent-tools_serve`) or bare. */
const isTool = (name: string, tool: string): boolean =>
  name === tool || name.endsWith(`_${tool}`);

/** Mail work: the user's inbox, drafts, sends. */
const MAIL_TOOL = /gmail|outlook|e-?mail|inbox|mail_/i;
/** Image and video work. */
const MEDIA_TOOL = /image|flux|video/i;

const HTML_FILE = /\.html?$/i;

export class SuccessPitchWatch {
  private readonly turns = new Map<string, TurnFacts>();
  private readonly lastReply = new Map<string, LastReply>();

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
        lead: null,
        tools: 0,
        troubled: false,
        reply: "",
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
    if (words.length > 0) this.endOffer(sessionId, isComplaint(words));
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
    facts.reply = "";
    const name = event.tool.name;
    if (event.result.rejected === true) {
      facts.troubled = true;
      return;
    }
    if (CARD_TOOLS.some((tool) => isTool(name, tool))) facts.troubled = true;
    facts.tools += 1;
    if (MAIL_TOOL.test(name)) facts.lead ??= "agents";
    if (MEDIA_TOOL.test(name)) facts.lead = "media";
    if (isTool(name, "serve") && event.tool.input.action === "start") {
      facts.delivered = "site";
      return;
    }
    for (const draft of handedOverArtifacts(
      payload,
      this.deps.workspacePath(sessionId)
    )) {
      const site =
        (draft.kind === "link" && isDeliverableUrl(draft.location)) ||
        HTML_FILE.test(draft.location);
      if (site) facts.delivered = "site";
      else facts.delivered ??= "file";
      if (draft.kind === "image") facts.lead = "media";
    }
  }

  /** A turn closed (TurnLedger), once: the pitch is decided here. */
  turnClosed(record: TurnRecord): Promise<void> {
    const facts = this.turns.get(record.sessionId) ?? null;
    this.turns.delete(record.sessionId);
    const previous = this.lastReply.get(record.sessionId) ?? null;
    this.lastReply.delete(record.sessionId);
    if (
      record.kind !== "reply" ||
      facts == null ||
      !facts.byUser ||
      !this.deps.pitchable(record.sessionId)
    )
      return Promise.resolve();
    // A result, for both signals: the turn did work, untroubled, and the
    // reply does not say it failed.
    const clean =
      facts.tools > 0 && !facts.troubled && isCleanReply(facts.reply);
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
    const signal: {
      trigger: SuccessPitchTrigger;
      moment: SuccessPitchMoment;
      lead: SuccessPitchLead | null;
    } | null =
      clean && facts.delivered != null
        ? { trigger: "deliverable", moment: facts.delivered, lead }
        : facts.praise && previous?.clean === true
          ? {
              trigger: "positive_reaction",
              moment: "reaction",
              lead: previous.lead ?? facts.lead,
            }
          : null;
    return this.decide(record.sessionId, where, signal, record.turnId);
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
      { trigger: "positive_reaction", moment: "reaction", lead: previous.lead },
      `${previous.turnId}:reaction`,
      false
    );
  }

  private async decide(
    sessionId: string,
    where: "app" | "chat",
    signal: {
      trigger: SuccessPitchTrigger;
      moment: SuccessPitchMoment;
      lead: SuccessPitchLead | null;
    } | null,
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
    const card = row.dismissals.successPitchCards?.[key];
    const now = this.now();
    const write = (next: SuccessPitchMark) =>
      prefs.update({
        successPitch: { ...prefs.get().successPitch, [key]: next },
      });
    if (signal == null || !successPitchAllowed(card, mark, now)) {
      if (countTurn) write(mark);
      return;
    }
    if (where === "app") {
      const offer: SuccessPitchOffer = {
        id: offerId,
        sessionId,
        ...signal,
        at: now,
      };
      write({ ...mark, offer });
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

  /** The user moved on in `sessionId`: its offer ends; a complaint withdraws it. */
  private endOffer(sessionId: string, complaint: boolean): void {
    const prefs = this.deps.prefs();
    if (prefs == null) return;
    const marks = prefs.get().successPitch ?? {};
    for (const [key, mark] of Object.entries(marks)) {
      if (mark.offer?.sessionId !== sessionId) continue;
      if (complaint)
        this.deps.funnel("success_pitch_withdrawn", mark.offer.trigger);
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
