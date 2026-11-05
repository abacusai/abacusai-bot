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
import {
  MAX_CHANNEL_MEMBERS,
  MIN_CHANNEL_MEMBERS,
  type Channel,
  type ChannelMessage,
  type ChannelSummary,
  type ChannelThread,
} from "@abacus-ai/contract/channels";
import { EntityNotFoundError } from "@abacus-ai/contract/not-found";
import { InvalidInputError } from "@abacus-ai/contract/service-errors";

import { abacusBotHome } from "../../paths";
import { answerWords, noteGist } from "../bots/bot-ask";
import {
  asksFirst,
  ownerOf,
  agreedItems,
  MAX_DISCUSSION_ROUNDS,
  channelTitle,
  channelWorkPrompt,
  proposalIn,
  workIn,
  FIRST_TURN_MESSAGES,
  goesAhead,
  MAX_NEW_MESSAGES,
  mentionedIn,
  type Member,
  postedWords,
  plainStop,
  speakersFor,
  stopWorkIn,
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
    workId: string
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

const STOPPED_PARTWAY = "You stopped it partway, so it may be half done.";

/** Messages kept per thread; older ones are dropped. */
const KEPT_MESSAGES = 1000;

/** "decided: …" / "decision: …" pins the rest of the line. */
const DECIDED = /^\s*(?:decided|decision)\s*:\s*(.+)$/is;

interface Round {
  userMessageId: string;
  cancelled: boolean;
}

export class ChannelService {
  private readonly queues = new Map<string, Round[]>();
  private readonly running = new Map<string, Round>();
  private readonly working = new Map<string, Set<string>>();
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
          this.stopWorks(channelId, botId);
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
    this.deps.store.writeChannels(
      this.deps.store.readChannels().filter((entry) => entry.id !== channelId)
    );
    this.deps.store.removeMessages(channelId);
    this.deps.forgetChats?.(channelId, channel.memberBotIds);
    this.queues.delete(channelId);
    this.log(`removed ${channelId}`);
    this.deps.changed(null);
  }

  /** The user's message: posted now, answered when its turn comes. */
  post(channelId: string, text: string, replyTo?: string): void {
    const channel = this.channel(channelId);
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
      if (thread.some((message) => message.work?.status === "running"))
        this.deps.store.writeMessages(
          channel.id,
          thread.map((message) =>
            message.work?.status === "running"
              ? {
                  ...message,
                  work: {
                    ...message.work,
                    status: "failed" as const,
                    error:
                      "The app closed while it was working on it, so it may be half done.",
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
  startAgreed(channelId: string, messageId: string): void {
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
    const userMessage: ChannelMessage = {
      id: this.newId(),
      author: { kind: "user" },
      text: userWords,
      at: this.now(),
    };
    this.append(channelId, userMessage);
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
        work: { task, status: "running", startedAt: this.now() },
      };
      this.append(channelId, card);
      this.startWork(channelId, owner, card.id, task, userMessage.id, true);
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
    this.stopWorks(channelId);
    this.log(`stopped ${channelId}`);
    this.deps.changed(channelId);
  }

  /** The channel's running work stops; only this bot's, when one is named. */
  private stopWorks(channelId: string, botId?: string): void {
    for (const [messageId, work] of this.works)
      if (
        work.channelId === channelId &&
        (botId == null || work.botId === botId)
      ) {
        this.stoppedWorks.add(messageId);
        this.works.delete(messageId);
        this.deps.stopWork?.(messageId);
        // Shown at once, and so the bots' next turns read it as stopped.
        this.setWork(channelId, messageId, {
          status: "stopped",
          error: STOPPED_PARTWAY,
        });
      }
  }

  /** A bot was deleted: it leaves every channel. */
  forgetBot(botId: string): void {
    for (const channel of this.deps.store.readChannels()) {
      if (!channel.memberBotIds.includes(botId)) continue;
      this.deps.stopTurn(botId, channel.id);
      this.stopWorks(channel.id, botId);
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
      this.startAgreed(channelId, lastSpeaker.id);
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
      if (stopped.length === 0) this.stopWorks(channelId);
      else for (const botId of stopped) this.stopWorks(channelId, botId);
    }

    if (speakers.discussion === true) {
      await this.discuss(channelId, round, speakers.botIds);
      return;
    }

    if (speakers.everyone) {
      // Each on its own: none is shown another's answer to this message.
      await Promise.all(
        speakers.botIds.map((botId) =>
          this.turn(channelId, round, botId, "everyone", [], userMessage.id)
        )
      );
      return;
    }

    const spoken = new Set<string>();
    for (const botId of speakers.botIds) {
      if (round.cancelled) return;
      if (spoken.has(botId)) continue;
      const reply = await this.turn(channelId, round, botId, "answer", []);
      spoken.add(botId);
      if (reply.length === 0) continue;
      const asker = this.deps.bot(botId);
      const brought = mentionedIn(reply, this.members(this.channel(channelId)))
        // One the user named answers in its own turn, not as brought in.
        .filter(
          (id) =>
            id !== botId && !spoken.has(id) && !speakers.botIds.includes(id)
        );
      for (const other of brought) {
        if (round.cancelled) return;
        await this.turn(channelId, round, other, "brought-in", [
          asker?.name ?? "Another bot",
        ]);
        spoken.add(other);
      }
      if (brought.length > 0 && !round.cancelled)
        await this.turn(
          channelId,
          round,
          botId,
          "follow-up",
          brought.map((id) => this.deps.bot(id)?.name ?? "A bot")
        );
    }
  }

  /**
   * One bot's turn: shown what it has not seen, its answer posted. Resolves
   * with the posted words ("" for none or a failure).
   */
  private async turn(
    channelId: string,
    round: Round,
    botId: string,
    kind: TurnKind,
    others: string[],
    /** For "everyone": show nothing after this message. */
    upTo?: string,
    extra: { round?: { at: number; of: number }; conclusion?: boolean } = {}
  ): Promise<string> {
    if (round.cancelled) return "";
    const channel = this.maybeChannel(channelId);
    const me = this.deps.bot(botId);
    if (channel == null || me == null || !channel.memberBotIds.includes(botId))
      return "";
    const members = this.members(channel);
    const all = this.deps.store.readMessages(channelId);
    const end =
      upTo == null
        ? all.length
        : all.findIndex((message) => message.id === upTo) + 1;
    const trigger = all.findIndex(
      (message) => message.id === round.userMessageId
    );
    const visible = all
      .slice(0, end > 0 ? end : all.length)
      // A discussion is about the message that started it: what the user
      // writes meanwhile ends it (see discuss) and is answered after.
      .filter(
        (message, index) =>
          (kind !== "discuss" && kind !== "conclude") ||
          index <= trigger ||
          message.author.kind !== "user"
      );
    const seenId = channel.seen?.[botId];
    const seenAt =
      seenId == null
        ? -1
        : visible.findIndex((message) => message.id === seenId);
    const fresh = visible
      .slice(seenAt + 1)
      .filter(
        (message) =>
          !(message.author.kind === "bot" && message.author.botId === botId)
      );
    const cap = seenAt < 0 ? FIRST_TURN_MESSAGES : MAX_NEW_MESSAGES;
    const unseen = fresh.slice(-cap);
    const nameOf = (id: string): string => this.deps.bot(id)?.name ?? "a bot";
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
      nameOf,
      myWork: all.flatMap((message) =>
        message.work != null &&
        message.author.kind === "bot" &&
        message.author.botId === botId
          ? [message.work]
          : []
      ),
      ...(extra.round != null ? { round: extra.round } : {}),
    });
    const userMessageId = round.userMessageId;
    const set = this.working.get(channelId) ?? new Set<string>();
    set.add(botId);
    this.working.set(channelId, set);
    this.deps.changed(channelId);
    try {
      const raw = await this.deps.runTurn(botId, channel, prompt);
      // Seen up to the last message shown; a user message kept from a
      // discussion turn, and everything after it, is still new next time.
      const hiddenAt = all.findIndex(
        (message, index) =>
          !visible.includes(message) &&
          index > trigger &&
          index < (end > 0 ? end : all.length)
      );
      const last = hiddenAt > 0 ? all[hiddenAt - 1] : visible.at(-1);
      if (last != null) this.markSeen(channelId, botId, last.id);
      if (round.cancelled || !this.isMember(channelId, botId)) return "";
      // The user cancelled or changed its running work: it stops first, so
      // a changed task (a new <work>) does not wait behind the old one.
      const stopped = stopWorkIn(postedWords(answerWords(raw), me));
      if (stopped.stop && (kind === "answer" || kind === "everyone")) {
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
        suggested == null || (kind !== "answer" && kind !== "conclude")
          ? null
          : suggested.invite
            ? existing != null && !channel.memberBotIds.includes(existing.id)
              ? { ...suggested, title: existing.title, botId: existing.id }
              : null
            : existing == null && this.deps.createBot != null
              ? suggested
              : null;
      const taken = workIn(proposed.words);
      // Only a bot answering the user's own message (alone or as one of
      // everyone) may take work on, and only when it is not asking whether to.
      const task =
        (kind === "answer" || kind === "everyone") &&
        this.deps.runWork != null &&
        !asksFirst(taken.words)
          ? taken.task
          : null;
      const words =
        taken.words.length > 0 || task == null ? taken.words : `On it: ${task}`;
      if (words.length === 0) return "";
      const message: ChannelMessage = {
        id: this.newId(),
        author: { kind: "bot", botId },
        text: words,
        at: this.now(),
        replyTo: userMessageId,
        ...(task != null
          ? {
              work: { task, status: "running" as const, startedAt: this.now() },
            }
          : {}),
        ...(extra.conclusion === true ? { conclusion: true } : {}),
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
      if (extra.conclusion === true)
        this.noteMembers(
          channel,
          `The team agreed, summed up by ${me.name}: ${noteGist(words, 600)}`
        );
      if (task != null)
        this.startWork(channelId, botId, message.id, task, userMessageId);
      return words;
    } catch (error) {
      // Stopped, or it left the channel (or the channel is gone) meanwhile.
      if (round.cancelled || !this.isMember(channelId, botId)) return "";
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
      return "";
    } finally {
      this.working.get(channelId)?.delete(botId);
      this.deps.changed(channelId);
    }
  }

  /**
   * The user asked the team to work it out together: rounds in which every
   * member speaks in turn, seeing the others, until a round adds nothing
   * (each may pass) or MAX_DISCUSSION_ROUNDS; then the lead sums up. The
   * rule bounds it, not the bots: they cannot start rounds or bring anyone
   * in, and Stop ends it.
   */
  private async discuss(
    channelId: string,
    round: Round,
    botIds: readonly string[]
  ): Promise<void> {
    let spoke = 0;
    for (let at = 1; at <= MAX_DISCUSSION_ROUNDS; at++) {
      let added = 0;
      for (const botId of botIds) {
        if (round.cancelled) return;
        // The user spoke: the team stops debating and the lead sums up;
        // their message is answered next, with the discussion in view.
        if ((this.queues.get(channelId) ?? []).length > 0) {
          at = MAX_DISCUSSION_ROUNDS;
          break;
        }
        const words = await this.turn(
          channelId,
          round,
          botId,
          "discuss",
          [],
          undefined,
          { round: { at, of: MAX_DISCUSSION_ROUNDS } }
        );
        if (words.length > 0) added++;
      }
      spoke += added;
      if (added === 0 || (at > 1 && added <= 1)) break;
    }
    const lead = botIds[0];
    if (lead == null || round.cancelled || spoke < 2) return;
    await this.turn(channelId, round, lead, "conclude", [], undefined, {
      conclusion: true,
    });
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
    fromPlan = false
  ): void {
    const channel = this.maybeChannel(channelId);
    const runWork = this.deps.runWork;
    if (channel == null || runWork == null) return;
    const userWords =
      this.deps.store
        .readMessages(channelId)
        .find((message) => message.id === userMessageId)?.text ?? "";
    const prompt = channelWorkPrompt({
      prefix: BOT_TASK_PREFIX,
      channelTitle: channelTitle(
        channel,
        (id) => this.deps.bot(id)?.name ?? null
      ),
      task,
      userWords,
      decisions: channel.decisions,
      fromPlan,
    });
    this.works.set(messageId, { channelId, botId });
    this.log(`work started by ${botId} in ${channelId}`);
    void runWork(botId, channel, prompt, messageId)
      .then((raw) => {
        // Stopped as it ended: it stays stopped, and its report is not posted.
        if (this.stoppedWorks.has(messageId)) return;
        const report = answerWords(raw).trim();
        this.setWork(channelId, messageId, { status: "done" });
        this.noteMembers(
          channel,
          `I did: ${noteGist(task, 120)} — ${noteGist(report, 300)}`,
          botId
        );
        this.append(channelId, {
          id: this.newId(),
          author: { kind: "bot", botId },
          text: report.length > 0 ? report : "Done.",
          at: this.now(),
          replyTo: userMessageId,
        });
      })
      .catch((error: unknown) => {
        const stopped = this.stoppedWorks.delete(messageId);
        const why = error instanceof Error ? error.message : String(error);
        this.setWork(channelId, messageId, {
          status: stopped ? "stopped" : "failed",
          error: stopped ? STOPPED_PARTWAY : why,
        });
      })
      .finally(() => {
        this.works.delete(messageId);
        this.stoppedWorks.delete(messageId);
        this.deps.changed(channelId);
      });
  }

  private readonly stoppedWorks = new Set<string>();

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
              work: { ...message.work, ...change, endedAt: this.now() },
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
      working: [
        ...new Set([
          ...(this.working.get(channel.id) ?? []),
          ...[...this.works.values()]
            .filter((work) => work.channelId === channel.id)
            .map((work) => work.botId),
        ]),
      ],
      queued: (this.queues.get(channel.id) ?? []).length,
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
