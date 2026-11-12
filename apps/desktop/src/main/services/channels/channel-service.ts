/**
 * Channels: the user and several of their bots in one thread (the rules
 * are in channel-logic.ts). This runs them: one user message at a time per
 * channel (a "round"), each bot's turn in its own hidden chat for the
 * channel (`<bot>|bot-channel:<id>`, run by the host), the answer posted to the
 * thread. Stop ends the round and drops the ones waiting.
 *
 * Stored in `~/.abacusai-bot/bot-channels.json` (the channels) and
 * `~/.abacusai-bot/bot-channels/<id>.json` (each thread). A message the app
 * closed on before any bot answered it is answered at the next start
 * (recover); one some bots had answered is left as it is.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";
import { BOT_TASK_PREFIX } from "@abacus-ai/agent/bot-task";
import type { BotTaskTag } from "@abacus-ai/contract/agent-types";
import {
  MAX_CHANNEL_MEMBERS,
  MIN_CHANNEL_MEMBERS,
  type Channel,
  type ChannelMessage,
  type ChannelSummary,
  type ChannelThread,
  type ChannelWorkStatus,
} from "@abacus-ai/contract/channels";
import { EntityNotFoundError } from "@abacus-ai/contract/not-found";
import { InvalidInputError } from "@abacus-ai/contract/service-errors";

import { abacusBotHome } from "../../paths";
import { answerWords, BOT_ANSWER_SEGMENT, noteGist } from "../bots/bot-ask";
import { TurnStoppedError } from "../session/turn-stopped";
import {
  asksFirst,
  ownerOf,
  agreedItems,
  chainAllowed,
  chainDoneIn,
  chainIn,
  type ChainStep,
  stepHandoff,
  channelTitle,
  channelWorkPrompt,
  channelFolder,
  proposalIn,
  workIn,
  FIRST_TURN_MESSAGES,
  goesAhead,
  MAX_NEW_MESSAGES,
  MAX_STEP_HANDOFF_CHARS,
  mentionedIn,
  mentionsEveryone,
  EVERYONE_ALL,
  ownWords,
  channelUserWords,
  claimsWork,
  agreesOnWork,
  type Member,
  type OwnChat,
  postedWords,
  plainStop,
  speakersFor,
  TALK_ROUNDS,
  stopWorkIn,
  withTagsAfterReply,
  turnPrompt,
  type TurnKind,
} from "./channel-logic";

/** The sender-chat "platform" of a bot's chat for a channel: `<bot>|bot-channel:<id>`. Not "channel": a removed feature of that name
 * still has its rows and its `channels.json` dropped at startup. */
export const CHANNEL_PLATFORM = "bot-channel";

/** A channel as stored: what each bot has been shown so far. */
export interface StoredChannel extends Channel {
  /** Bot id → id of the last message that bot was shown. */
  seen?: Record<string, string>;
  /** The user's messages waiting for or in their round, oldest first. */
  pending?: string[];
}

export interface ChannelStore {
  readChannels: () => StoredChannel[];
  writeChannels: (channels: StoredChannel[]) => void;
  readMessages: (channelId: string) => ChannelMessage[];
  writeMessages: (channelId: string, messages: ChannelMessage[]) => void;
  removeMessages: (channelId: string) => void;
}

export interface ChannelDeps {
  store: ChannelStore;
  /** The bot, while it exists. */
  bot: (botId: string) => Member | null;
  /**
   * The bot's own chat with the user as it stands: whether a turn runs
   * there now, and its last exchanges, both sides. Absent: not told.
   */
  ownChat?: (botId: string) => OwnChat;
  /**
   * Run one turn of the bot in its chat for this channel and resolve with
   * the turn's raw text; reject when it fails, is stopped or runs too long.
   */
  runTurn: (botId: string, channel: Channel, prompt: string) => Promise<string>;
  /** Stop the bot's running turn in this channel, if any. */
  stopTurn: (botId: string, channelId: string) => void;
  /**
   * Run work a bot took on in the channel in its own chat, with its normal
   * tools, and resolve with that turn's raw text; reject when it fails, is
   * stopped or runs too long. Absent: bots cannot take work on here.
   */
  runWork?: (
    botId: string,
    channel: Channel,
    prompt: string,
    /** Its card's message id: what stopWork names. */
    workId: string,
    /** What the bot's own chat draws in place of the prompt. */
    card: BotTaskTag
  ) => Promise<string>;
  /** Stop that work: now if it is running, before it starts if it waits. */
  stopWork?: (workId: string) => void;
  /**
   * Make a bot the user approved from a proposal; the proposer's model is
   * its default. Absent: bots cannot propose new bots here.
   */
  createBot?: (input: {
    name: string;
    title: string;
    description: string;
    likeBotId: string;
  }) => Member;
  /** All the user's bots: who may be invited, and names a new bot cannot take. */
  allBots?: () => Member[];
  /** The channel is gone, or these bots left it: their chats for it can go. */
  forgetChats?: (channelId: string, botIds: readonly string[]) => void;
  /** Something in the channel (null: the list) changed. */
  changed: (channelId: string | null) => void;
  /** A line for the bot's own daily notes: what the channel settled, what it did here. */
  note?: (botId: string, line: string) => void;
  /** One line per event, no message text: for the app's log. */
  log?: (line: string) => void;
  now?: () => number;
  newId?: () => string;
}

/** Marks a chain step's report that ended the chain; never posted. */
const CHAIN_DONE_MARK = "\u0000chain-done\u0000";

const STOPPED_PARTWAY = "You stopped it partway, so it may be half done.";
const STOPPED_BEFORE_START = "You stopped it before it started.";

/** Work not over yet: waiting for the bot's own chat, or running there. */
const isOpen = (status: ChannelWorkStatus | undefined): boolean =>
  status === "waiting" || status === "running";

/** Messages kept per thread; older ones are dropped. */
const KEPT_MESSAGES = 1000;

/** "decided: …" / "decision: …" pins the rest of the line. */
const DECIDED = /^\s*(?:decided|decision)\s*:\s*(.+)$/is;

interface Round {
  userMessageId: string;
  cancelled: boolean;
  /** A lead turn after this member's work report, not an answer to the user. */
  leadAfter?: string;
}

/**
 * Lead turns after work reports, per user message: the lead keeps the user's
 * goal moving between their messages, and this bounds it (the user's next
 * message, or Stop, starts again or ends it).
 */
export const MAX_LEAD_TURNS = 8;

/** Asked once of a bot whose reply says work is happening that it never started. */
const CLAIM_NUDGE =
  "Your last message in the channel said you are doing work, but you started nothing, so nothing is running. Reply again in the channel: start it now with <work>the task, complete on its own</work>, or say plainly that you have not started and what you are waiting for.";

/** A hand-off chain running in a channel: its steps, and the one it is at. */
interface ChainRun {
  cancelled: boolean;
  steps: readonly ChainStep[];
  at: number;
  /** The card of the step running now. */
  cardId?: string;
}

export class ChannelService {
  private readonly queues = new Map<string, Round[]>();
  private readonly running = new Map<string, Round>();
  private readonly working = new Map<string, Set<string>>();
  /** Hand-off chains running in each channel: Stop and a stop word end them. */
  private readonly chains = new Map<string, Set<ChainRun>>();
  /**
   * A report that found other work still running, per channel: whichever of
   * that work ends last wakes the lead for it, plan work and failures too.
   */
  private readonly owedWakes = new Map<
    string,
    { reporter: string; userMessageId: string }
  >();
  /**
   * Messages of talk (a turn that posted words and started no work) since
   * the user's last message, per channel: at TALK_ROUNDS per member the lead
   * checks in with the user and the floor waits for them.
   */
  private readonly talk = new Map<string, number>();
  /** Channels whose lead checked in: no more talk until the user answers. */
  private readonly talkPaused = new Set<string>();
  /** Lead turns since the user's last message, per channel (MAX_LEAD_TURNS). */
  private readonly leadTurns = new Map<string, number>();
  /** Work running in bots' own chats: message id → its channel and bot. */
  private readonly works = new Map<
    string,
    { channelId: string; botId: string }
  >();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly deps: ChannelDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => randomBytes(6).toString("hex"));
  }

  list(): ChannelSummary[] {
    return this.deps.store
      .readChannels()
      .map((channel) => this.summary(channel))
      .sort(
        (a, b) => (b.last?.at ?? b.updatedAt) - (a.last?.at ?? a.updatedAt)
      );
  }

  thread(channelId: string): ChannelThread {
    const channel = this.channel(channelId);
    return {
      channel: this.summary(channel),
      messages: this.deps.store.readMessages(channelId),
    };
  }

  create(input: {
    botIds: string[];
    name?: string;
    about?: string;
    text?: string;
  }): ChannelSummary {
    const memberBotIds = this.validMembers(input.botIds);
    const at = this.now();
    const channel: StoredChannel = {
      id: this.newId(),
      name: input.name?.trim() ?? "",
      ...(input.about != null && input.about.trim().length > 0
        ? { about: input.about.trim() }
        : {}),
      memberBotIds,
      decisions: [],
      createdAt: at,
      updatedAt: at,
      seen: {},
    };
    channel.folder = this.newFolder(channel);
    this.deps.store.writeChannels([...this.deps.store.readChannels(), channel]);
    this.deps.store.writeMessages(channel.id, []);
    this.log(`created ${channel.id} with ${memberBotIds.length} bots`);
    this.deps.changed(null);
    if (input.text != null && input.text.trim().length > 0)
      this.post(channel.id, input.text);
    return this.summary(this.channel(channel.id));
  }

  update(
    channelId: string,
    input: { name?: string; about?: string; botIds?: string[] }
  ): ChannelSummary {
    const channel = this.channel(channelId);
    const next: StoredChannel = { ...channel, updatedAt: this.now() };
    if (input.name != null) next.name = input.name.trim();
    if (input.about != null) next.about = input.about.trim();
    if (input.botIds != null) {
      next.memberBotIds = this.validMembers(input.botIds);
      const left = channel.memberBotIds.filter(
        (id) => !next.memberBotIds.includes(id)
      );
      if (left.length > 0) {
        for (const botId of left) {
          this.deps.stopTurn(botId, channelId);
          this.stopWorks(channelId, botId, {
            why: `${this.deps.bot(botId)?.name ?? "The bot"} left the channel, so its work stopped.`,
          });
        }
        const seen = { ...channel.seen };
        for (const botId of left) delete seen[botId];
        next.seen = seen;
        this.deps.forgetChats?.(channelId, left);
      }
    }
    this.save(next);
    this.deps.changed(channelId);
    return this.summary(next);
  }

  remove(channelId: string): void {
    const channel = this.channel(channelId);
    this.stop(channelId);
    // Its notes stay in each member's memory: say they no longer apply.
    this.noteMembers(
      channel,
      "This channel was deleted. What was decided or agreed in it no longer applies unless the user says so."
    );
    this.deps.store.writeChannels(
      this.deps.store.readChannels().filter((entry) => entry.id !== channelId)
    );
    this.deps.store.removeMessages(channelId);
    this.deps.forgetChats?.(channelId, channel.memberBotIds);
    this.queues.delete(channelId);
    this.talk.delete(channelId);
    this.talkPaused.delete(channelId);
    this.leadTurns.delete(channelId);
    this.owedWakes.delete(channelId);
    this.chains.delete(channelId);
    this.log(`removed ${channelId}`);
    this.deps.changed(null);
  }

  /** The user's message: posted now, answered when its turn comes. */
  post(channelId: string, text: string, replyTo?: string): void {
    const channel = this.channel(channelId);
    // Every member was deleted: nobody would ever answer.
    if (this.members(channel).length === 0)
      throw new InvalidInputError(
        "This channel has no bots left. Add bots to use it again."
      );
    const message: ChannelMessage = {
      id: this.newId(),
      author: { kind: "user" },
      text: text.trim(),
      at: this.now(),
      ...(replyTo != null ? { replyTo } : {}),
    };
    this.append(channelId, message);
    const decided = DECIDED.exec(message.text)?.[1]?.trim();
    if (decided != null && decided.length > 0)
      this.addDecision(channel.id, decided, message.id);
    this.setPending(channelId, (ids) => [...ids, message.id]);
    this.leadTurns.delete(channelId);
    this.talk.delete(channelId);
    this.talkPaused.delete(channelId);
    this.owedWakes.delete(channelId);
    // A lead turn queued after a report gives way: the user's message is
    // answered next, and answered once.
    const queued = this.queues.get(channelId);
    if (queued != null)
      this.queues.set(
        channelId,
        queued.filter((round) => round.leadAfter == null)
      );
    this.enqueue(channelId, message.id);
  }

  /**
   * At startup: the user's messages the app closed on. One no bot answered
   * yet gets its round now; one some bots had answered is left as it is
   * (the user can ask again), so nobody answers twice.
   */
  recover(): void {
    for (const channel of this.deps.store.readChannels()) {
      const thread = this.deps.store.readMessages(channel.id);
      if (thread.some((message) => isOpen(message.work?.status)))
        this.deps.store.writeMessages(
          channel.id,
          thread.map((message) =>
            isOpen(message.work?.status)
              ? {
                  ...message,
                  work: {
                    ...message.work,
                    status: "failed" as const,
                    error:
                      message.work?.status === "waiting"
                        ? "The app closed before it started."
                        : "The app closed while it was working on it, so it may be half done.",
                    endedAt: this.now(),
                  },
                }
              : message
          )
        );
      const pending = channel.pending ?? [];
      if (pending.length === 0) continue;
      const messages = this.deps.store.readMessages(channel.id);
      const answered = new Set(
        messages
          .filter((message) => message.author.kind === "bot")
          .map((message) => message.replyTo)
      );
      const again = pending.filter(
        (id) =>
          !answered.has(id) && messages.some((message) => message.id === id)
      );
      this.setPending(channel.id, () => again);
      for (const id of again) this.enqueue(channel.id, id);
      if (again.length > 0)
        this.log(`recovered ${again.length} message(s) in ${channel.id}`);
    }
  }

  private enqueue(channelId: string, userMessageId: string): void {
    const queue = this.queues.get(channelId) ?? [];
    queue.push({ userMessageId, cancelled: false });
    this.queues.set(channelId, queue);
    this.deps.changed(channelId);
    this.pump(channelId);
  }

  private setPending(
    channelId: string,
    change: (ids: string[]) => string[]
  ): void {
    const channel = this.maybeChannel(channelId);
    if (channel == null) return;
    this.save({ ...channel, pending: change(channel.pending ?? []) });
  }

  pin(channelId: string, input: { text?: string; messageId?: string }): void {
    const messages = this.deps.store.readMessages(channelId);
    const text =
      input.text?.trim() ??
      messages.find((message) => message.id === input.messageId)?.text.trim();
    if (text == null || text.length === 0)
      throw new InvalidInputError("There is nothing to pin.");
    this.addDecision(channelId, text, input.messageId);
    this.deps.changed(channelId);
  }

  unpin(channelId: string, decisionId: string): void {
    const channel = this.channel(channelId);
    const gone = channel.decisions.find((entry) => entry.id === decisionId);
    if (gone != null)
      this.noteMembers(
        channel,
        `No longer settled: ${noteGist(gone.text, 300)}`
      );
    this.save({
      ...channel,
      decisions: channel.decisions.filter((entry) => entry.id !== decisionId),
      updatedAt: this.now(),
    });
    this.deps.changed(channelId);
  }

  /**
   * The user's answer to a proposed bot: create it (with the proposer's
   * model) and add it to the channel, or dismiss it. Only the user calls
   * this; a bot cannot create a bot on its own.
   */
  decideProposal(channelId: string, messageId: string, create: boolean): void {
    const channel = this.channel(channelId);
    const messages = this.deps.store.readMessages(channelId);
    const message = messages.find((entry) => entry.id === messageId);
    const proposal = message?.proposal;
    if (message == null || proposal == null || proposal.status !== "proposed")
      throw new InvalidInputError("That proposal was already decided.");
    let botId = proposal.botId;
    if (create) {
      if (channel.memberBotIds.length >= MAX_CHANNEL_MEMBERS)
        throw new InvalidInputError(
          `This channel already has ${MAX_CHANNEL_MEMBERS} bots: remove one first.`
        );
      if (proposal.invite === true) {
        if (botId == null || this.deps.bot(botId) == null)
          throw new InvalidInputError(
            `${proposal.name} is no longer one of your bots.`
          );
      } else {
        const createBot = this.deps.createBot;
        if (createBot == null)
          throw new InvalidInputError("Bots cannot be created here.");
        botId = createBot({
          name: proposal.name,
          title: proposal.title,
          description: proposal.mission,
          likeBotId: message.author.kind === "bot" ? message.author.botId : "",
        }).id;
      }
      this.save({
        ...this.channel(channelId),
        memberBotIds: [...this.channel(channelId).memberBotIds, botId],
        updatedAt: this.now(),
      });
      this.log(
        `${proposal.invite === true ? "added" : "created"} bot ${botId} from a proposal in ${channelId}`
      );
    }
    this.deps.store.writeMessages(
      channelId,
      messages.map((entry) =>
        entry.id === messageId && entry.proposal != null
          ? {
              ...entry,
              proposal: {
                ...entry.proposal,
                status: create ? ("created" as const) : ("dismissed" as const),
                ...(botId != null ? { botId } : {}),
              },
            }
          : entry
      )
    );
    this.deps.changed(channelId);
    this.deps.changed(null);
  }

  /**
   * The user starts a discussion's agreed plan: each agreed item goes to the
   * member it names (else the lead) as work in that bot's own chat, one card
   * per item in the channel. The user's click is the authority; the items
   * are the team's words the user just approved.
   */
  startAgreed(
    channelId: string,
    messageId: string,
    /** The user's own go-ahead ("yes, go ahead"): it starts the plan, no line is added for them. */
    goAhead?: ChannelMessage
  ): void {
    if (this.deps.runWork == null)
      throw new InvalidInputError("Work cannot be started here.");
    const channel = this.channel(channelId);
    const messages = this.deps.store.readMessages(channelId);
    const conclusion = messages.find((entry) => entry.id === messageId);
    if (conclusion?.conclusion !== true)
      throw new InvalidInputError(
        "Only a discussion's agreed points can be started."
      );
    if (conclusion.planStarted === true)
      throw new InvalidInputError("This plan was already started.");
    const members = this.members(channel);
    const lead = members[0];
    if (lead == null) throw new InvalidInputError("This channel has no bots.");
    const items = agreedItems(conclusion.text);
    const userWords = `Start the team's agreed plan: ${items.map((item, index) => `${index + 1}. ${item}`).join(" ")}`;
    this.deps.store.writeMessages(
      channelId,
      messages.map((entry) =>
        entry.id === messageId ? { ...entry, planStarted: true } : entry
      )
    );
    // The Start button leaves a line saying what the click started; a
    // go-ahead in words is that line already.
    const userMessage: ChannelMessage = goAhead ?? {
      id: this.newId(),
      author: { kind: "user" },
      text: userWords,
      at: this.now(),
    };
    if (goAhead == null) this.append(channelId, userMessage);
    this.talk.delete(channelId);
    this.talkPaused.delete(channelId);
    // One card per owner, with all its items: its own chat runs one turn at a time.
    const byOwner = new Map<string, string[]>();
    for (const item of items) {
      const owner = ownerOf(item, members) ?? lead.id;
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), item]);
    }
    for (const [owner, own] of byOwner) {
      const task =
        own.length === 1
          ? own[0]!
          : own.map((item, index) => `${index + 1}. ${item}`).join("\n");
      const card: ChannelMessage = {
        id: this.newId(),
        author: { kind: "bot", botId: owner },
        text:
          own.length === 1
            ? `On it: ${own[0]}`
            : `On it (${own.length} items):\n${task}`,
        at: this.now(),
        replyTo: userMessage.id,
        work: { task, status: "waiting", startedAt: this.now() },
      };
      this.append(channelId, card);
      void this.startWork(
        channelId,
        owner,
        card.id,
        task,
        userMessage.id,
        true
      );
    }
    this.log(`started ${items.length} agreed item(s) in ${channelId}`);
  }

  /** Every bot answering stops; messages waiting are not answered. */
  stop(channelId: string): void {
    const round = this.running.get(channelId);
    if (round != null) round.cancelled = true;
    for (const waiting of this.queues.get(channelId) ?? [])
      waiting.cancelled = true;
    this.queues.set(channelId, []);
    this.setPending(channelId, () => []);
    for (const botId of this.working.get(channelId) ?? []) {
      this.deps.stopTurn(botId, channelId);
      // A trace, for the user and the bots: an answer that never came is
      // otherwise invisible, and a bot waiting on it may assume it did.
      this.append(channelId, {
        id: this.newId(),
        author: { kind: "bot", botId },
        text: `${this.deps.bot(botId)?.name ?? "A bot"} was stopped before answering.`,
        at: this.now(),
        ...(round != null ? { replyTo: round.userMessageId } : {}),
        failed: true,
      });
    }
    // Stop ends it all: no report woken later.
    this.owedWakes.delete(channelId);
    this.cancelChains(channelId);
    this.stopWorks(channelId);
    this.talk.delete(channelId);
    this.log(`stopped ${channelId}`);
    this.deps.changed(channelId);
  }

  /** The channel's running work stops; only this bot's, when one is named. */
  private stopWorks(
    channelId: string,
    botId?: string,
    /** Only this card, if named, and why it stopped (not the user's Stop). */
    only?: { messageId?: string; why: string }
  ): void {
    for (const [messageId, work] of this.works)
      if (
        work.channelId === channelId &&
        (botId == null || work.botId === botId) &&
        (only?.messageId == null || only.messageId === messageId)
      ) {
        this.stoppedWorks.add(messageId);
        this.works.delete(messageId);
        this.deps.stopWork?.(messageId);
        const waiting =
          this.deps.store
            .readMessages(channelId)
            .find((message) => message.id === messageId)?.work?.status ===
          "waiting";
        // Shown at once, and so the bots' next turns read it as stopped.
        this.setWork(channelId, messageId, {
          status: "stopped",
          error:
            only?.why ?? (waiting ? STOPPED_BEFORE_START : STOPPED_PARTWAY),
        });
      }
  }

  /**
   * The work's prompt is on its way to the bot's own chat: the card was
   * waiting for that chat until now.
   */
  workStarted(messageId: string): void {
    const work = this.works.get(messageId);
    if (work == null) return;
    const status = this.deps.store
      .readMessages(work.channelId)
      .find((message) => message.id === messageId)?.work?.status;
    if (status === "waiting")
      this.setWork(work.channelId, messageId, { status: "running" });
  }

  /** A bot was deleted: it leaves every channel. */
  forgetBot(botId: string): void {
    for (const channel of this.deps.store.readChannels()) {
      if (!channel.memberBotIds.includes(botId)) continue;
      this.deps.stopTurn(botId, channel.id);
      this.stopWorks(channel.id, botId, {
        why: "The bot was deleted, so its work stopped.",
      });
      const seen = { ...channel.seen };
      delete seen[botId];
      this.save({
        ...channel,
        memberBotIds: channel.memberBotIds.filter((id) => id !== botId),
        seen,
      });
      this.deps.changed(channel.id);
    }
  }

  private pump(channelId: string): void {
    if (this.running.has(channelId)) return;
    const round = this.queues.get(channelId)?.shift();
    if (round == null) return;
    this.running.set(channelId, round);
    void this.runRound(channelId, round)
      .catch((error: unknown) =>
        this.log(`round in ${channelId} failed: ${String(error)}`)
      )
      .finally(() => {
        this.running.delete(channelId);
        this.setPending(channelId, (ids) =>
          ids.filter((id) => id !== round.userMessageId)
        );
        this.deps.changed(channelId);
        this.pump(channelId);
      });
  }

  private async runRound(channelId: string, round: Round): Promise<void> {
    if (round.cancelled) return;
    const channel = this.maybeChannel(channelId);
    if (channel == null) return;
    const members = this.members(channel);
    const messages = this.deps.store.readMessages(channelId);
    const index = messages.findIndex(
      (message) => message.id === round.userMessageId
    );
    const userMessage = messages[index];
    if (userMessage == null) return;
    // A work report landed: the lead (the first member) picks the goal up.
    if (round.leadAfter != null) {
      const lead = channel.memberBotIds[0];
      if (lead == null) return;
      // "@Chooser, pick the winner": whoever the lead names speaks next.
      await this.floor(channelId, round, [
        {
          botId: lead,
          kind: "report",
          others: [this.deps.bot(round.leadAfter)?.name ?? "A member"],
        },
      ]);
      return;
    }
    const before = messages.slice(0, index);
    const lastSpeaker = [...before]
      .reverse()
      .find((message) => message.author.kind === "bot" && !message.failed);
    // "Yes, go ahead" after the team's Agreed: the agreed work starts, as
    // the Start button would; the cards and reports are the answer.
    if (
      lastSpeaker?.conclusion === true &&
      lastSpeaker.planStarted !== true &&
      this.deps.runWork != null &&
      goesAhead(userMessage.text, members)
    ) {
      this.startAgreed(channelId, lastSpeaker.id, userMessage);
      this.log(`agreed work started by the user's words in ${channelId}`);
      return;
    }
    const repliedTo = messages.find(
      (message) => message.id === userMessage.replyTo
    );
    const speakers = speakersFor(userMessage.text, members, {
      replyToBot:
        repliedTo?.author.kind === "bot" ? repliedTo.author.botId : null,
      lastSpeaker:
        lastSpeaker?.author.kind === "bot" ? lastSpeaker.author.botId : null,
      // A question anywhere in it: bots ask, then add a line or two.
      lastSpeakerAsked: (lastSpeaker?.text ?? "").includes("?"),
    });
    this.log(
      `round in ${channelId}: ${speakers.everyone ? "everyone" : speakers.botIds.length} speaker(s)`
    );
    // "Stop", "cancel that": the bots it is for stop their work now, before
    // they answer, rather than each deciding whether to.
    // Naming nobody ("stop", "@everyone stop"), it stops all the channel's work.
    const stopped = plainStop(userMessage.text, members);
    if (stopped != null) {
      this.cancelChains(channelId, stopped);
      if (stopped.length === 0) this.stopWorks(channelId);
      else for (const botId of stopped) this.stopWorks(channelId, botId);
    }

    if (speakers.everyone) {
      // Told to everyone: every member keeps it, in any chat.
      if (mentionsEveryone(userMessage.text) && stopped == null)
        this.noteMembers(
          this.channel(channelId),
          `The user told everyone: ${noteGist(userMessage.text, 300)}`
        );
      // Every member, in turn, each seeing what the others said.
      await this.floor(
        channelId,
        round,
        speakers.botIds.map((botId) => ({
          botId,
          kind: "everyone",
          others: [],
        })),
        stopped != null,
        // Only an "@everyone" round is summed up; a message to all without
        // it ("hi both", "one line each") is answered and left there.
        mentionsEveryone(userMessage.text)
      );
      return;
    }

    await this.floor(
      channelId,
      round,
      speakers.botIds.map((botId) => ({ botId, kind: "answer", others: [] })),
      stopped != null
    );
  }

  /**
   * The floor: the bots in `queue` speak in turn, and whoever a reply
   * @names speaks next (after those already waiting), seeing the whole
   * thread. One rule for every case: a hand-off ("@Writer, pick one"), a
   * question to a colleague, two bots debating. It ends when a reply names
   * nobody new, the user writes, Stop, or the talk reaches the check-in (see
   * talk); a bot that answered the user and called others in then finishes.
   */
  private async floor(
    channelId: string,
    round: Round,
    queue: { botId: string; kind: TurnKind; others: string[] }[],
    /** Answering a stop: the bots answer it, and their @names call nobody. */
    quiet = false,
    /** The one that opened may sum up (not after a message to all without @everyone). */
    sumUp = true
  ): Promise<void> {
    const opener = queue[0];
    let hopped = false;
    let last: string | null = null;
    const answered: string[] = [];
    let worked = false;
    let ran = 0;
    for (let next = queue.shift(); next != null; next = queue.shift()) {
      // A user message waiting gets the floor, once this one's first turn is
      // over: each message is answered by its own round.
      if (round.cancelled || (ran > 0 && this.userWaiting(channelId))) return;
      if (this.talkPaused.has(channelId)) return;
      if (this.talkedOut(channelId)) {
        await this.checkIn(channelId, round);
        return;
      }
      const { words, acted, chained } = await this.turn(
        channelId,
        round,
        next.botId,
        next.kind,
        next.others
      );
      ran++;
      // A hand-off just started: its members speak through their steps, so
      // those still waiting their turn here (named by the user) step back.
      if (chained.length > 0)
        for (let at = queue.length - 1; at >= 0; at--)
          if (chained.includes(queue[at]!.botId)) queue.splice(at, 1);
      if (words.length === 0) continue;
      last = next.botId;
      if (next.botId !== opener?.botId) answered.push(next.botId);
      if (acted) worked = true;
      else this.talk.set(channelId, (this.talk.get(channelId) ?? 0) + 1);
      const channel = this.maybeChannel(channelId);
      if (channel == null) return;
      const asker = this.deps.bot(next.botId)?.name ?? "Another bot";
      // An @name inside quoted text (an email, code) calls nobody.
      const said = ownWords(words);
      const called = (
        mentionsEveryone(said)
          ? channel.memberBotIds
          : mentionedIn(said, this.members(channel))
      ).filter(
        // A hand-off's members speak through their steps, not here; in an
        // @everyone round each member answers once and @names call nobody.
        (id) =>
          id !== next.botId &&
          !chained.includes(id) &&
          !quiet &&
          next.kind !== "everyone"
      );
      // Named while already waiting (the user's order, "then Writer"): it
      // speaks in its place, and that is no exchange to sum up.
      const named = called.filter(
        (id) => !queue.some((item) => item.botId === id)
      );
      if (named.length > 0) hopped = true;
      for (const id of named)
        queue.push({ botId: id, kind: "brought-in", others: [asker] });
    }
    if (
      round.cancelled ||
      quiet ||
      this.talkPaused.has(channelId) ||
      this.userWaiting(channelId)
    )
      return;
    // The talk ran out on the last turn: the check-in, not a summing-up.
    if (this.talkedOut(channelId)) {
      await this.checkIn(channelId, round);
      return;
    }
    // Others spoke after the one that opened (it called them in, or everyone
    // answered) and started no work, whose cards say where it stands: it sums
    // up for the user, or passes when there is nothing to sum up.
    if (
      sumUp &&
      opener != null &&
      (opener.kind === "answer" || opener.kind === "everyone") &&
      (hopped || opener.kind === "everyone") &&
      answered.length > 0 &&
      !worked &&
      last !== opener.botId
    )
      await this.turn(
        channelId,
        round,
        opener.botId,
        "follow-up",
        [...new Set(answered)].map((id) => this.deps.bot(id)?.name ?? "A bot"),
        opener.kind === "everyone" && !hopped
      );
  }

  /** A user message waits behind this round: the bots give it the floor. */
  private userWaiting(channelId: string): boolean {
    return (this.queues.get(channelId) ?? []).some(
      (queued) => queued.leadAfter == null
    );
  }

  /** The bots have talked TALK_ROUNDS times each since the user last wrote. */
  private talkedOut(channelId: string): boolean {
    const channel = this.maybeChannel(channelId);
    if (channel == null) return true;
    return (
      (this.talk.get(channelId) ?? 0) >=
      TALK_ROUNDS * channel.memberBotIds.length
    );
  }

  /**
   * The talk reached its check-in: the lead tells the user where things
   * stand and asks whether to go on; nobody talks again until they answer.
   */
  private async checkIn(channelId: string, round: Round): Promise<void> {
    this.talkPaused.add(channelId);
    const lead = this.maybeChannel(channelId)?.memberBotIds[0];
    this.log(`talk in ${channelId} reached its check-in`);
    if (lead != null) await this.turn(channelId, round, lead, "check-in", []);
  }

  /**
   * One bot's turn: shown what it has not seen, its answer posted. Resolves
   * with the posted words ("" for none or a failure), and whether it started
   * work or a hand-off chain.
   */
  private async turn(
    channelId: string,
    round: Round,
    botId: string,
    kind: TurnKind,
    others: string[],
    /** For follow-up: it closes a round to everyone, with no exchange. */
    afterEveryone = false
  ): Promise<{ words: string; acted: boolean; chained: string[] }> {
    const none = { words: "", acted: false, chained: [] };
    if (round.cancelled) return none;
    const channel = this.maybeChannel(channelId);
    const me = this.deps.bot(botId);
    if (channel == null || me == null || !channel.memberBotIds.includes(botId))
      return none;
    const members = this.members(channel);
    const all = this.deps.store.readMessages(channelId);
    const seenId = channel.seen?.[botId];
    const seenAt =
      seenId == null ? -1 : all.findIndex((message) => message.id === seenId);
    const fresh = all
      .slice(seenAt + 1)
      // Its own messages are in its channel chat already, except a work
      // report, written in its own chat: that it is shown, like the others'.
      .filter(
        (message) =>
          message.report === true ||
          !(message.author.kind === "bot" && message.author.botId === botId)
      );
    const cap = seenAt < 0 ? FIRST_TURN_MESSAGES : MAX_NEW_MESSAGES;
    const unseen = fresh.slice(-cap);
    const nameOf = (id: string): string => this.deps.bot(id)?.name ?? "a bot";
    // Who the user named anywhere in this channel: their words, not the
    // latest message alone, say which members may take work on or be chained.
    const userWordsHere = channelUserWords(all);
    const named = (words: string, id: string): boolean =>
      chainAllowed(words, [{ botId: id, task: "" }], members, "");
    // In an @everyone round, a member the message itself gives a part by
    // name ("@everyone: Writer drafts it, Researcher checks prices").
    const roundWords = (
      all.find((message) => message.id === round.userMessageId)?.text ?? ""
    ).replace(EVERYONE_ALL, " ");
    const mayWork =
      this.deps.runWork != null &&
      (kind === "answer" ||
        kind === "report" ||
        (kind === "brought-in" && named(userWordsHere, botId)) ||
        // Otherwise an @everyone round is talk: its work is the summing-up's
        // agreed list, started by the user's go.
        (kind === "everyone" && named(roundWords, botId)));
    const chainStep = this.chainStepFor(channelId, botId);
    const prompt = turnPrompt({
      channelTitle: channelTitle(
        channel,
        (id) => this.deps.bot(id)?.name ?? null
      ),
      ...(channel.about != null ? { about: channel.about } : {}),
      today: new Date(this.now()).toLocaleDateString("en-GB", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      }),
      me,
      members,
      decisions: channel.decisions,
      outsiders: (this.deps.allBots?.() ?? []).filter(
        (bot) => !channel.memberBotIds.includes(bot.id)
      ),
      unseen,
      skipped: fresh.length - unseen.length,
      kind,
      others,
      ...(kind === "brought-in" || kind === "everyone" ? { mayWork } : {}),
      nameOf,
      ...(chainStep != null ? { chainStep } : {}),
      ...(afterEveryone ? { afterEveryone } : {}),
      ...(all.some(
        (message) =>
          message.author.kind === "bot" &&
          !channel.memberBotIds.includes(message.author.botId)
      )
        ? { othersLeft: true }
        : {}),
      myWork: all.flatMap((message) =>
        message.work != null &&
        message.author.kind === "bot" &&
        message.author.botId === botId
          ? [message.work]
          : []
      ),
      ...(this.deps.ownChat != null
        ? { ownChat: this.deps.ownChat(botId) }
        : {}),
    });
    const userMessageId = round.userMessageId;
    const set = this.working.get(channelId) ?? new Set<string>();
    set.add(botId);
    this.working.set(channelId, set);
    this.deps.changed(channelId);
    try {
      let raw = await this.deps.runTurn(botId, channel, prompt);
      // It says work is happening and started none: asked once to start it
      // or say plainly it has not, so the channel holds no false progress.
      if (
        mayWork &&
        !round.cancelled &&
        !/<work>|<chain\b/i.test(raw) &&
        claimsWork(postedWords(answerWords(raw), me)) &&
        !this.hasLiveWork(channelId, botId)
      ) {
        this.log(
          `${botId} claimed work it had not started in ${channelId}: asked again`
        );
        raw = await this.deps.runTurn(botId, channel, CLAIM_NUDGE);
      }
      // Seen up to the last message shown.
      const last = all.at(-1);
      if (last != null) this.markSeen(channelId, botId, last.id);
      if (round.cancelled || !this.isMember(channelId, botId)) return none;
      // The user cancelled or changed its running work: it stops first, so
      // a changed task (a new <work>) does not wait behind the old one.
      const stopped = stopWorkIn(
        postedWords(withTagsAfterReply(answerWords(raw), raw), me)
      );
      if (stopped.stop) {
        this.stopWorks(channelId, botId);
        this.log(`${botId} stopped its work in ${channelId}`);
      }
      const proposed = proposalIn(stopped.words);
      // A bot answering the user, or the lead summing up, may suggest a bot:
      // one of the user's not here (invite), or a new one (create).
      const suggested = proposed.proposal;
      const existing = (this.deps.allBots?.() ?? []).find(
        (bot) => bot.name.toLowerCase() === suggested?.name.toLowerCase()
      );
      const proposal =
        suggested == null || (kind !== "answer" && kind !== "follow-up")
          ? null
          : suggested.invite
            ? existing != null && !channel.memberBotIds.includes(existing.id)
              ? { ...suggested, title: existing.title, botId: existing.id }
              : null
            : existing == null && this.deps.createBot != null
              ? suggested
              : null;
      // A hand-off chain (answering the user only, every bot in it named by
      // the user): it runs past this round, step after step.
      const chained = chainIn(proposed.words, members);
      const steps =
        (kind === "answer" || kind === "report") &&
        this.deps.runWork != null &&
        chained.steps != null &&
        chainAllowed(userWordsHere, chained.steps, members, botId)
          ? chained.steps
          : null;
      if (chained.steps != null && steps == null)
        this.log(
          `${botId} wrote a chain in ${channelId} the user did not ask for: not run`
        );
      const taken = workIn(chained.words);
      // Only a bot answering the user's own message (alone or as one of
      // everyone) may take work on, and only when it is not asking whether to.
      // Its part of a hand-off already running starts with its step, not now.
      const task =
        steps == null &&
        mayWork &&
        !asksFirst(taken.words) &&
        this.chainStepFor(channelId, botId) == null
          ? taken.task
          : null;
      // A chain it was not let run: its words would promise work nobody does.
      const unnamed =
        chained.steps != null &&
        steps == null &&
        (kind === "answer" || kind === "report")
          ? [
              ...new Set(
                chained.steps
                  .filter(
                    (step) =>
                      step.botId !== botId && !named(userWordsHere, step.botId)
                  )
                  .map((step) => nameOf(step.botId))
              ),
            ]
          : [];
      const refused =
        chained.unknown != null
          ? `\n\n(The hand-off did not start: ${chained.unknown} is not in this channel. Add it to the channel, or ask a member.)`
          : unnamed.length > 0
            ? `\n\n(The hand-off did not start: you have not named ${unnamed.join(" or ")} in this channel. Ask again naming every bot it needs, e.g. "have ${unnamed[0]} fix it".)`
            : "";
      const words =
        taken.words.length > 0
          ? taken.words + refused
          : refused.length > 0
            ? refused.trim()
            : task != null
              ? `On it: ${task}`
              : steps != null
                ? `Starting the hand-off: ${steps.map((step) => nameOf(step.botId)).join(" → ")}.`
                : "";
      if (words.length === 0) return none;
      // The opener's summing-up, or the lead's check-in, settled work: it
      // can be pinned and started (the Start button, or the user's "yes").
      // Not while work is under way: a summing-up of a running build is
      // where it stands, and its Start would run that work a second time.
      const concluded =
        (kind === "follow-up" || kind === "check-in") &&
        agreesOnWork(words) &&
        !this.busy(channelId);
      const message: ChannelMessage = {
        id: this.newId(),
        author: { kind: "bot", botId },
        text: words,
        at: this.now(),
        replyTo: userMessageId,
        ...(task != null
          ? {
              work: { task, status: "waiting" as const, startedAt: this.now() },
            }
          : {}),
        ...(concluded ? { conclusion: true } : {}),
        ...(proposal != null
          ? {
              proposal: {
                name: proposal.name,
                title: proposal.title,
                mission: proposal.mission,
                status: "proposed" as const,
                ...("botId" in proposal
                  ? { invite: true, botId: proposal.botId }
                  : {}),
              },
            }
          : {}),
      };
      this.append(channelId, message);
      if (concluded)
        this.noteMembers(
          channel,
          `The team agreed, summed up by ${me.name}: ${noteGist(words, 1500)}`
        );
      // A summing-up with no task list still settles things ("the name is
      // Brewly"): every member keeps it.
      else if (kind === "follow-up" || kind === "check-in")
        this.noteMembers(
          channel,
          `Where the team got to, summed up by ${me.name}: ${noteGist(words, 1500)}`
        );
      if (task != null)
        void this.startWork(channelId, botId, message.id, task, userMessageId);
      if (steps != null) void this.runChain(channelId, steps, userMessageId);
      return {
        words,
        acted: task != null || steps != null,
        chained: (steps ?? []).map((step) => step.botId),
      };
    } catch (error) {
      // Stopped, or it left the channel (or the channel is gone) meanwhile.
      if (round.cancelled || !this.isMember(channelId, botId)) return none;
      const why = error instanceof Error ? error.message : String(error);
      this.log(`${botId} could not answer in ${channelId}: ${why}`);
      this.append(channelId, {
        id: this.newId(),
        author: { kind: "bot", botId },
        text: `${me.name} couldn't answer: ${why}`,
        at: this.now(),
        replyTo: userMessageId,
        failed: true,
      });
      return none;
    } finally {
      this.working.get(channelId)?.delete(botId);
      this.deps.changed(channelId);
    }
  }

  /**
   * The work a bot took on runs in its own chat, past this round: the
   * channel goes on meanwhile. Its card shows the status; the report is
   * posted as the bot's message when it ends.
   */
  private startWork(
    channelId: string,
    botId: string,
    messageId: string,
    task: string,
    userMessageId: string,
    fromPlan = false,
    chain?: {
      step: number;
      steps: readonly { bot: string; task: string }[];
      previous?: { bot: string; report: string };
    }
  ): Promise<string | null> {
    const channel = this.maybeChannel(channelId);
    const runWork = this.deps.runWork;
    if (channel == null || runWork == null) return Promise.resolve(null);
    const title = channelTitle(
      channel,
      (id) => this.deps.bot(id)?.name ?? null
    );
    const prompt = channelWorkPrompt({
      prefix: BOT_TASK_PREFIX,
      channelTitle: title,
      task,
      folder: this.folderOf(channel),
      decisions: channel.decisions,
      fromPlan,
      ...(chain != null ? { chain } : {}),
    });
    // The bot's own chat shows the card a passed-on task gets, from the channel.
    const card: BotTaskTag = {
      askId: messageId,
      passerId: channelId,
      passer: title,
      channelId,
      task,
      // Its card shows its own task, not the user's whole channel message.
      userWords: task,
    };
    // Work that ends by itself (a report, or a failure) wakes the lead to keep
    // the user's goal moving; stopped work wakes nobody, and an agreed plan's
    // work, a scope the user started, only pays a wake another report left
    // owed. A hand-off's lead is woken when the hand-off ends (runChain).
    const afterWork = (wakes: boolean): void => {
      if (chain != null) return;
      if (wakes && !fromPlan) this.wakeLead(channelId, botId, userMessageId);
      else this.payOwedWake(channelId);
    };
    this.works.set(messageId, { channelId, botId });
    this.log(`work started by ${botId} in ${channelId}`);
    return runWork(botId, channel, prompt, messageId, card)
      .then((raw): string | null => {
        // Stopped as it ended: it stays stopped, and its report is not posted.
        if (this.stoppedWorks.has(messageId)) return null;
        // A work report is the result: kept whole up to what a hand-off
        // step passes on, not cut like a short answer.
        const answered = answerWords(raw, MAX_STEP_HANDOFF_CHARS).trim();
        // A step's "nothing left to do" mark is the app's, never posted (plain
        // work can carry it over from a hand-off it ran before).
        const ended = chainDoneIn(answered);
        const report = ended.words;
        this.setWork(channelId, messageId, { status: "done" });
        this.noteMembers(
          channel,
          `I did: ${noteGist(task, 120)} — ${noteGist(report, 300)}`,
          botId
        );
        this.append(channelId, {
          id: this.newId(),
          author: { kind: "bot", botId },
          text:
            (report.length > 0 ? report : "Done.") +
            (ended.done && chain != null && chain.step < chain.steps.length
              ? `\n\nNothing left to do, so the hand-off ends here (step ${chain.step} of ${chain.steps.length}).`
              : ""),
          at: this.now(),
          replyTo: userMessageId,
          report: true,
        });
        afterWork(true);
        if (chain == null) return report;
        // The next step gets the whole turn, not only the posted message.
        const whole = chainDoneIn(
          stepHandoff(raw.split(BOT_ANSWER_SEGMENT))
        ).words;
        return ended.done ? `${CHAIN_DONE_MARK}${whole}` : whole;
      })
      .catch((error: unknown): null => {
        // Stopped here (the card was set as it stopped), or in the bot's own
        // chat: a stop, not a failure.
        if (this.stoppedWorks.delete(messageId)) {
          afterWork(false);
          return null;
        }
        if (error instanceof TurnStoppedError) {
          this.setWork(channelId, messageId, {
            status: "stopped",
            error: STOPPED_PARTWAY,
          });
          this.log(`work ${messageId} in ${channelId} stopped in its own chat`);
          afterWork(false);
          return null;
        }
        const why = error instanceof Error ? error.message : String(error);
        this.setWork(channelId, messageId, { status: "failed", error: why });
        afterWork(true);
        return null;
      })
      .finally(() => {
        this.works.delete(messageId);
        this.stoppedWorks.delete(messageId);
        this.deps.changed(channelId);
      });
  }

  private readonly stoppedWorks = new Set<string>();

  /**
   * A hand-off chain the user started: each step is a work card in that
   * bot's own chat, run after the one before, given its report. It ends
   * after the last step, at a step that found nothing left (<chain_done/>),
   * at a step that failed or was stopped, or when the user stops the channel.
   */
  private async runChain(
    channelId: string,
    steps: readonly ChainStep[],
    userMessageId: string
  ): Promise<void> {
    // A new hand-off is the plan now: the one running here stops, its step
    // in flight included, so two plans never build the same thing twice.
    for (const old of this.chains.get(channelId) ?? [])
      if (!old.cancelled && old.cardId != null)
        this.stopWorks(channelId, undefined, {
          messageId: old.cardId,
          why: "A newer hand-off replaced it.",
        });
    this.cancelChains(channelId);
    const run: ChainRun = { cancelled: false, steps, at: 0 };
    const running = this.chains.get(channelId) ?? new Set<ChainRun>();
    running.add(run);
    this.chains.set(channelId, running);
    const id = this.newId();
    const named = steps.map((step) => ({
      bot: this.deps.bot(step.botId)?.name ?? "a bot",
      task: step.task,
    }));
    let previous: { bot: string; report: string } | undefined;
    try {
      for (const [index, step] of steps.entries()) {
        if (run.cancelled || !this.isMember(channelId, step.botId)) return;
        run.at = index;
        const card: ChannelMessage = {
          id: this.newId(),
          author: { kind: "bot", botId: step.botId },
          text: `Step ${index + 1} of ${steps.length}: ${step.task}`,
          at: this.now(),
          replyTo: userMessageId,
          work: {
            task: step.task,
            status: "waiting",
            startedAt: this.now(),
            chain: { id, step: index + 1, of: steps.length },
          },
        };
        this.append(channelId, card);
        run.cardId = card.id;
        const report = await this.startWork(
          channelId,
          step.botId,
          card.id,
          step.task,
          userMessageId,
          false,
          {
            step: index + 1,
            steps: named,
            ...(previous != null ? { previous } : {}),
          }
        );
        if (report == null) {
          // Stopped (here or in its bot's chat): the hand-off ends, and the
          // lead is not woken to carry on what the user stopped.
          if (
            this.deps.store
              .readMessages(channelId)
              .find((message) => message.id === card.id)?.work?.status ===
            "stopped"
          )
            run.cancelled = true;
          this.log(
            `chain ${id} in ${channelId} ended at step ${index + 1}: failed or stopped`
          );
          return;
        }
        if (report.startsWith(CHAIN_DONE_MARK)) {
          this.log(
            `chain ${id} in ${channelId} done at step ${index + 1} of ${steps.length}`
          );
          return;
        }
        previous = { bot: named[index]!.bot, report };
      }
      this.log(`chain ${id} in ${channelId} ran all ${steps.length} steps`);
    } finally {
      running.delete(run);
      const last = steps.at(-1);
      if (!run.cancelled && last != null)
        this.wakeLead(channelId, last.botId, userMessageId);
      else this.payOwedWake(channelId);
    }
  }

  /** The bot's next step in a hand-off running here that has not started yet. */
  private chainStepFor(
    channelId: string,
    botId: string
  ): { step: number; of: number } | null {
    for (const run of this.chains.get(channelId) ?? []) {
      if (run.cancelled) continue;
      const index = run.steps.findIndex(
        (step, at) => at >= run.at && step.botId === botId
      );
      if (index >= 0) return { step: index + 1, of: run.steps.length };
    }
    return null;
  }

  /**
   * The channel's files folder: chosen once, from its name then (or its
   * members' names), with a short id so two "Brewly"s don't share one.
   */
  private newFolder(channel: Channel): string {
    const title = channelTitle(
      channel,
      (id) => this.deps.bot(id)?.name ?? null
    );
    return `${channelFolder(title)}-${channel.id.slice(0, 4)}`;
  }

  /** The folder, saved on a channel made before it had one. */
  private folderOf(channel: Channel): string {
    if (channel.folder != null) return channel.folder;
    const folder = this.newFolder(channel);
    this.save({ ...this.channel(channel.id), folder });
    return folder;
  }

  /** Whether the bot has work in this channel waiting or running. */
  private hasLiveWork(channelId: string, botId: string): boolean {
    return this.deps.store
      .readMessages(channelId)
      .some(
        (message) =>
          message.work != null &&
          isOpen(message.work.status) &&
          message.author.kind === "bot" &&
          message.author.botId === botId
      );
  }

  /**
   * A member's work report landed: once nothing else is running in the
   * channel (the last report wakes it), the lead gets a turn to start the
   * next piece or tell the user it is done. Bounded by MAX_LEAD_TURNS per
   * user message; the user's next message or Stop ends it.
   */
  private wakeLead(
    channelId: string,
    reporter: string,
    userMessageId: string
  ): void {
    if (this.deps.runWork == null || this.maybeChannel(channelId) == null)
      return;
    if (this.busy(channelId)) {
      this.owedWakes.set(channelId, { reporter, userMessageId });
      return;
    }
    this.owedWakes.delete(channelId);
    const turns = this.leadTurns.get(channelId) ?? 0;
    if (turns >= MAX_LEAD_TURNS) {
      this.log(
        `lead turns in ${channelId} reached ${MAX_LEAD_TURNS}: waiting for the user`
      );
      return;
    }
    this.leadTurns.set(channelId, turns + 1);
    const queue = this.queues.get(channelId) ?? [];
    queue.push({ userMessageId, cancelled: false, leadAfter: reporter });
    this.queues.set(channelId, queue);
    this.log(`lead woken in ${channelId} after ${reporter}'s report`);
    this.deps.changed(channelId);
    this.pump(channelId);
  }

  /** Work or a hand-off chain still running in the channel. */
  private busy(channelId: string): boolean {
    return (
      (this.chains.get(channelId)?.size ?? 0) > 0 ||
      this.deps.store
        .readMessages(channelId)
        .some((message) => message.work != null && isOpen(message.work.status))
    );
  }

  /** The lead's wake a report left owed, once nothing is running. */
  private payOwedWake(channelId: string): void {
    const owed = this.owedWakes.get(channelId);
    if (owed != null && !this.busy(channelId))
      this.wakeLead(channelId, owed.reporter, owed.userMessageId);
  }

  /** The channel's hand-off chains run no further step. */
  private cancelChains(
    channelId: string,
    botIds: readonly string[] = []
  ): void {
    // Naming bots ("Coder stop"), only the chains they are in.
    for (const run of this.chains.get(channelId) ?? [])
      if (
        botIds.length === 0 ||
        run.steps.some((step) => botIds.includes(step.botId))
      )
        run.cancelled = true;
  }

  private setWork(
    channelId: string,
    messageId: string,
    change: Partial<NonNullable<ChannelMessage["work"]>>
  ): void {
    if (this.maybeChannel(channelId) == null) return;
    const messages = this.deps.store.readMessages(channelId);
    this.deps.store.writeMessages(
      channelId,
      messages.map((message) =>
        message.id === messageId && message.work != null
          ? {
              ...message,
              work: {
                ...message.work,
                ...change,
                ...(isOpen(change.status) ? {} : { endedAt: this.now() }),
              },
            }
          : message
      )
    );
    this.deps.changed(channelId);
  }

  private isMember(channelId: string, botId: string): boolean {
    return this.maybeChannel(channelId)?.memberBotIds.includes(botId) ?? false;
  }

  private markSeen(channelId: string, botId: string, messageId: string): void {
    const channel = this.maybeChannel(channelId);
    if (channel == null) return;
    this.save({ ...channel, seen: { ...channel.seen, [botId]: messageId } });
  }

  private addDecision(
    channelId: string,
    text: string,
    messageId?: string
  ): void {
    const channel = this.channel(channelId);
    if (channel.decisions.some((entry) => entry.text === text)) return;
    this.save({
      ...channel,
      decisions: [
        ...channel.decisions,
        {
          id: this.newId(),
          text,
          at: this.now(),
          ...(messageId != null ? { messageId } : {}),
        },
      ],
      updatedAt: this.now(),
    });
    this.noteMembers(channel, `Decided: ${noteGist(text, 300)}`);
  }

  /** The members' daily notes hear what the channel settled or did, tagged with the channel. */
  private noteMembers(channel: Channel, line: string, only?: string): void {
    const title = channelTitle(
      channel,
      (id) => this.deps.bot(id)?.name ?? null
    );
    const tag = `[channel "${title.replace(/["\n]/g, "'")}"]`;
    for (const botId of channel.memberBotIds)
      if (only == null || botId === only)
        this.deps.note?.(botId, `${tag} ${line}`);
  }

  private append(channelId: string, message: ChannelMessage): void {
    // A channel removed meanwhile (a late report): nothing is written back.
    const channel = this.maybeChannel(channelId);
    if (channel == null) return;
    const messages = [...this.deps.store.readMessages(channelId), message];
    this.deps.store.writeMessages(channelId, messages.slice(-KEPT_MESSAGES));
    this.save({ ...channel, updatedAt: message.at });
    this.deps.changed(channelId);
  }

  private members(channel: Channel): Member[] {
    return channel.memberBotIds
      .map((id) => this.deps.bot(id))
      .filter((member): member is Member => member != null);
  }

  private validMembers(botIds: readonly string[]): string[] {
    const ids = [...new Set(botIds)].filter((id) => this.deps.bot(id) != null);
    if (ids.length < MIN_CHANNEL_MEMBERS)
      throw new InvalidInputError(
        `A channel needs at least ${MIN_CHANNEL_MEMBERS} bots.`
      );
    if (ids.length > MAX_CHANNEL_MEMBERS)
      throw new InvalidInputError(
        `A channel can have at most ${MAX_CHANNEL_MEMBERS} bots.`
      );
    return ids;
  }

  private summary(channel: StoredChannel): ChannelSummary {
    const { seen: _seen, pending: _pending, ...rest } = channel;
    const last = this.deps.store.readMessages(channel.id).at(-1);
    return {
      ...rest,
      memberBotIds: channel.memberBotIds.filter(
        (id) => this.deps.bot(id) != null
      ),
      answering: [...(this.working.get(channel.id) ?? [])],
      working: [
        ...new Set([
          ...(this.working.get(channel.id) ?? []),
          ...[...this.works.values()]
            .filter((work) => work.channelId === channel.id)
            .map((work) => work.botId),
        ]),
      ],
      // The user's messages waiting, not the lead's own wake-ups.
      queued: (this.queues.get(channel.id) ?? []).filter(
        (queued) => queued.leadAfter == null
      ).length,
      ...(last != null
        ? { last: { author: last.author, text: last.text, at: last.at } }
        : {}),
    };
  }

  private maybeChannel(channelId: string): StoredChannel | null {
    return (
      this.deps.store.readChannels().find((entry) => entry.id === channelId) ??
      null
    );
  }

  private channel(channelId: string): StoredChannel {
    const channel = this.maybeChannel(channelId);
    if (channel == null)
      throw new EntityNotFoundError(
        "channel",
        channelId,
        "This channel is gone."
      );
    return channel;
  }

  private save(channel: StoredChannel): void {
    this.deps.store.writeChannels(
      this.deps.store
        .readChannels()
        .map((entry) => (entry.id === channel.id ? channel : entry))
    );
  }

  private log(line: string): void {
    this.deps.log?.(`[channels] ${line}`);
  }
}

/** The channel files, read fresh each time: one process writes them. */
export const fileChannelStore = (
  home: () => string = abacusBotHome
): ChannelStore => {
  const list = (): string => path.join(home(), "bot-channels.json");
  const thread = (id: string): string =>
    path.join(
      home(),
      "bot-channels",
      `${id.replace(/[^A-Za-z0-9_-]/g, "")}.json`
    );
  const readArray = <T>(file: string): T[] => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  };
  return {
    readChannels: () => readArray<StoredChannel>(list()),
    writeChannels: (channels) =>
      writeFileAtomicSync(list(), JSON.stringify(channels, null, 2)),
    readMessages: (id) => readArray<ChannelMessage>(thread(id)),
    writeMessages: (id, messages) => {
      fs.mkdirSync(path.dirname(thread(id)), { recursive: true });
      writeFileAtomicSync(thread(id), JSON.stringify(messages, null, 2));
    },
    removeMessages: (id) => fs.rmSync(thread(id), { force: true }),
  };
};
