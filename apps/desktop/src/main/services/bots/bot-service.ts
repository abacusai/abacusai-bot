/**
 * The bot lifecycle: persona files, the forever chat, and the first turn.
 * Given callbacks rather than the service host, so it stays testable and can
 * reach no further than it needs. The persona is a file the agent re-reads
 * per turn, so editing the bot updates a running chat without a respawn.
 */
import fs from "fs";
import path from "path";

import {
  readUserLanguage,
  resolveReplyLanguage,
} from "@abacus-ai/agent/user-language";
import { connectorById } from "@abacus-ai/connectors/registry";
import type { UserTextTags } from "@abacus-ai/contract/agent-types";
import {
  type Bot,
  type HomeChannel,
  type BotChangeNotice,
  type BotChatHandle,
  type BotCreateInput,
  type BotUpdateInput,
  HOME_CHANNEL_NAMES,
  HOME_CHANNELS,
  SPONSORED_RUN_MARKER,
} from "@abacus-ai/contract/bots";
import { goalOfMission } from "@abacus-ai/contract/bots/check-in";
import {
  BOT_TEMPLATES,
  type BotTemplate,
} from "@abacus-ai/contract/bots/templates";
import type { SessionOwner } from "@abacus-ai/contract/contracts";
import { EntityNotFoundError } from "@abacus-ai/contract/not-found";

import {
  channelLocale,
  channelWords,
  type ChannelWords,
} from "../messaging/channel-words";
import {
  botDir,
  botForSession,
  createBot,
  getBot,
  getSenderSession,
  listBots,
  listSenderSessions,
  personaPath,
  recordBotSession,
  recordSenderSession,
  removeBot,
  removeSenderSessionsForBot,
  senderSessionKey,
  updateBot,
  markBotKickstarted,
} from "./bot-store";

export interface BotServiceCallbacks {
  /** May create one: on a first run "no folder yet" cannot be a dead end. */
  resolveDefaultWorkspaceId: () => string | null | Promise<string | null>;
  /** Null when the workspace no longer exists or is tombstoned. */
  isWorkspaceUsable: (workspaceId: string) => boolean;
  sessionExists: (workspaceId: string, sessionId: string) => boolean;
  createSession: (workspaceId: string, owner: SessionOwner) => { id: string };
  /** Recover a conversation by its owner stamp when the registry lost it. */
  findOwnedSession: (
    botId: string,
    role: SessionOwner["role"],
    key: string | null
  ) => { workspaceId: string; sessionId: string } | null;
  updateSessionLabel: (
    workspaceId: string,
    sessionId: string,
    label: string
  ) => void;
  startSession: (
    workspaceId: string,
    sessionId: string
  ) => Promise<{ success: boolean; error?: string }>;
  sendMessage: (
    workspaceId: string,
    sessionId: string,
    message: string,
    userText?: UserTextTags
  ) => void;
  removeSession: (workspaceId: string, sessionId: string) => void;
  /**
   * Pin the chat to a model, so restarts keep it, and apply it to the
   * session's agent when one runs.
   */
  updateSessionModel: (
    workspaceId: string,
    sessionId: string,
    model: string
  ) => void;
  /**
   * The model a bot asking for `requested` (null: the app default) runs on:
   * `resolveConfiguredModel` over the live catalog and the stored default
   * (spec 03 §13.2). Null when nothing is runnable.
   */
  effectiveModel: (
    requested: string | null,
    /** The session's stored pin, kept when the catalog cannot judge. */
    pinned: string | null
  ) => string | null | Promise<string | null>;
  /** A session's workspace, owner stamp and pinned model; null when gone. */
  sessionInfo?: (sessionId: string) => {
    workspaceId: string;
    owner: SessionOwner | null;
    model: string | null;
  } | null;
  emitChanged: () => void;
  /**
   * Tear down what a deleted bot owned outside this service: an orphaned
   * routine would fire into a fresh anonymous session.
   */
  onBotRemoved?: (botId: string) => void;
  /** Each chat app's stored home bot; may name a bot since deleted. */
  homeBots?: () => Partial<Record<HomeChannel, string>>;
  /** Persist a chat app's home bot. Only setHomeBot calls it. */
  saveHomeBot?: (app: HomeChannel, botId: string) => void;
  /** The app's language tag (en-US, pt-BR); a first run writes in it. */
  appLanguage?: () => string;
}

/** The app's agent template (Telegram Agent and the like). */
const agentTemplateFor = (app: HomeChannel): BotTemplate => {
  const template = BOT_TEMPLATES.find((row) => row.homeChannel === app);
  if (template == null) throw new Error(`No agent template for ${app}.`);
  return template;
};

/** A chat-app agent's home: the app the user talks to it in. */
const homeChannelLines = (bot: Bot): string[] => {
  if (bot.homeChannel == null) return [];
  const app = HOME_CHANNEL_NAMES[bot.homeChannel];
  return ["", `**Your main connector to use is ${app}.**`];
};

/** What the bot's mission works through, by name: its home app first. */
const neededConnectorNames = (bot: Bot): string[] => [
  ...new Set([
    ...(bot.homeChannel != null ? [HOME_CHANNEL_NAMES[bot.homeChannel]] : []),
    ...(
      BOT_TEMPLATES.find((row) => row.id === bot.templateId)?.needs ?? []
    ).flatMap((id) => connectorById(id)?.name ?? []),
  ]),
];

/** Static per bot, so the cached prompt holds; the live state is in the reminder. */
const neededConnectorLines = (bot: Bot): string[] => {
  const names = neededConnectorNames(bot);
  if (names.length === 0) return [];
  return [
    "",
    `**Connectors your mission needs:** ${names.join(", ")}.`,
    "On your first turn, call connect_connector for each of these that the",
    "system reminder does not list as connected, before or with your greeting,",
    "then start on what works without them.",
  ];
};

/**
 * Which chat apps' own chats this bot answers, and for the others who does:
 * the user asking a bot to chat on an app should hear where it goes now.
 */
const homeBotLines = (
  bot: Bot,
  homes: Partial<Record<HomeChannel, Bot>>
): string[] =>
  HOME_CHANNELS.flatMap((channel) => {
    const home = homes[channel];
    if (home == null) return [];
    const app = HOME_CHANNEL_NAMES[channel];
    return home.id === bot.id
      ? [
          "",
          `The user's own ${app} chat comes to you: what they type there arrives here`,
          `marked as from ${app}, and your reply goes straight back to them there.`,
          'Replying IS messaging them, so when they say "send me X" or "message me",',
          "just answer with X.",
        ]
      : [
          "",
          `If the user asks to chat with you on ${app}, say their ${app} messages`,
          `currently go to ${home.name}, and offer to switch them to you; when they`,
          `agree, call take_chat_app_messages with app "${channel}". You can still`,
          `send them updates on ${app} either way.`,
        ];
  });

/**
 * A template's role kept after the user rewrote its mission: a bot told to
 * build sites must not still introduce itself as a Chief of Staff.
 */
const isStaleTemplateRole = (bot: Bot): boolean => {
  const template =
    BOT_TEMPLATES.find((row) => row.id === bot.templateId) ??
    BOT_TEMPLATES.find((row) => row.title === bot.title);
  return (
    template != null &&
    bot.title === template.title &&
    bot.description !== template.mission
  );
};

/**
 * The bot's standing prompt, framed like custom instructions and explicit
 * that the persona does not widen permissions.
 */
const renderPersona = (
  bot: Bot,
  homes: Partial<Record<HomeChannel, Bot>>
): string => {
  const role = bot.title.length > 0 ? bot.title : "assistant";

  return [
    `# ${bot.name}`,
    "",
    ...(isStaleTemplateRole(bot) ? [] : [`**Role:** ${role}`]),
    `**Your mission, yours alone:** ${bot.description}`,
    // Its own line so the model reads the voice as manner, not more mission.
    ...(bot.persona.length > 0
      ? [`**Your voice (how you speak, in every message):** ${bot.persona}`]
      : []),
    ...homeChannelLines(bot),
    ...neededConnectorLines(bot),
    ...homeBotLines(bot, homes),
    "",
    `You are ${bot.name}, a persistent named agent. This conversation is your`,
    "single ongoing chat with your user: it keeps its history across restarts,",
    "so treat it as a continuing working relationship, not a one-off session.",
    `If the user asks your name, answer "${bot.name}".`,
    "",
    "Stay in character and keep your mission in view. On the very first turn",
    "of the chat, greet the user briefly in your own voice and propose a few",
    "concrete things you can do for them based on your role, but if your",
    "mission already gives you a concrete assignment, treat that as what you",
    "were created to do: skip the getting-started questions and begin.",
    // Typing is work and tapping is not: a first reply that ends on a
    // question, or on having found nothing, is the one that goes unanswered.
    "Unless your mission says to ask what you are for, your first reply hands",
    "the user something (a result, a draft, a finding) and, when suggest_tasks",
    "is in your tool list, ends with it: two or three concrete tasks they can",
    'tap to run next. Never end it on an open question or on "nothing found".',
    "The same goes whenever the user greets you or asks what you can do:",
    "answer in a line or two and offer the tasks.",
    "",
    // Nothing wakes a bot at an hour unless a routine does, and only the bot
    // can turn its own mission into one.
    "If your mission names a time or a rhythm (every day at 10 am, weekday",
    "mornings, every hour), that is a routine, not a promise. Create it with",
    "the cronjob tool on your first turn, at the point your mission puts it:",
    "a mission that orders its steps is followed in that order. The schedule",
    "in cron, the recurring part of your mission as the prompt. A routine",
    "fires once on creation, which counts as its first pass, unless you pass",
    "firstRun: false; pass that when you have just done the pass yourself in",
    "this chat, so it is not done twice. Confirm to the user that it is set",
    "and when it fires next. Nothing will bring you back at that hour unless",
    'the routine exists, so never say you will "check again tomorrow" unless',
    "the routine that will is listed.",
    "",
    // A turn with tool calls is several replies stitched together; a model
    // that reads "first turn" as "first reply" greets after every tool result.
    "Introduce yourself once, in your first message, and never again. A tool",
    "result continues the reply you were already giving: pick up mid-stream",
    "with what you found or what comes next. Do not greet again, do not repeat",
    "your name or mission, and do not re-announce a plan you already stated.",
    "",
    // The examples must come from what a bot here can actually do, not the
    // menu any chat assistant could offer.
    "Draw those examples from what you can do in this app: messaging people on",
    "the chat apps that are connected (sending a WhatsApp update, answering a",
    "client on Telegram), working inside the tools that are attached, running",
    "on a schedule so a job happens without being asked, and reading, editing",
    "and running things in the workspace folder. Check which connectors are",
    "actually attached before naming one. When a task needs one that is",
    "missing, call connect_connector for it right away; do not ask or offer",
    "first. Never say a Connect card, link or QR code is waiting unless you",
    "called connect_connector for it in this turn.",
    "",
    "Your persona shapes tone and focus only. Approvals and the permission",
    "mode still decide what may actually run.",
  ].join("\n");
};

/**
 * What a bot's chat is told when the user edits what it is for. It
 * acknowledges and adjusts; redoing the mission could re-send a message the
 * user already has.
 */
const changeNotice = (notice: BotChangeNotice): string => {
  const changed: string[] = [];
  if (notice.mission) changed.push("your mission");
  if (notice.persona) changed.push("your persona");
  if (notice.checkIn != null)
    changed.push(`your check-in schedule (now: ${notice.checkIn})`);
  return (
    `[mission updated] The user just edited ${changed.join(", ")}. ` +
    "Read your updated standing prompt. In one short message, acknowledge " +
    "what changed and say what you will do differently from now on; if the " +
    "check-in schedule changed, say when the next check-in is. Do not " +
    "introduce yourself again, and do not carry out your mission now: " +
    "wait to be asked, or for the next check-in."
  );
};

/** A language's own name in its own locale: "Türkçe", "português". */
const nativeLanguageName = (locale: string): string => {
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(
      locale
    );
    return (name ?? locale).replace(/\s*\(.*\)$/, "");
  } catch {
    return locale;
  }
};

/**
 * Visible first message of a fresh bot chat, so the bot speaks first. Written
 * in the user's resolved reply language (the app's own locale files, English
 * for a language the app does not ship), never Hindi: a note in English is
 * what the model answers in English. The `[first run]` tag stays as is; the
 * app and the agent recognise the note by it.
 */
const kickstartMessage = (
  bot: Bot,
  language: string | null,
  words: ChannelWords
): string => {
  const { t } = words;
  const names = neededConnectorNames(bot);
  const connect =
    names.length === 0
      ? null
      : names.length === 1
        ? t("kickoff.connectOne", { name: names[0]! })
        : t("kickoff.connectMany", {
            names: new Intl.ListFormat(words.locale, {
              type: "conjunction",
            }).format(names),
          });
  const goal = goalOfMission(bot.description);
  const start =
    goal == null ? t("kickoff.startMission") : t("kickoff.startGoal", { goal });
  return `[first run] ${[
    connect,
    t("kickoff.introduce", { start }),
    t("kickoff.continuing"),
    language == null ? null : t("kickoff.write", { language }),
  ]
    .filter((part): part is string => part != null)
    .join(" ")}`;
};

/**
 * The rules of a sender conversation, delivered as a preamble on the first
 * inbound message rather than as a message of their own: a separate kickstart
 * can race the first inbound, and the rules must never arrive second.
 */
const senderChatIntro = (senderName: string, platform: string): string =>
  [
    `[auto-reply] This conversation is your line to ${senderName} on`,
    `${platform}, answering on the user's behalf. Every visible word you`,
    "write here is delivered to them and reads as if the user typed it. So:",
    "reply with exactly what should be sent, and nothing else: no status",
    "notes, no commentary, no questions meant for the user, no introducing",
    "yourself. Put the words to send inside <reply></reply>. ONLY what is",
    "inside that tag is delivered; think, plan or note anything outside it.",
    "Nothing runs after your reply (there is no later), so anything that",
    "needs looking up (weather, a search, a date) you do NOW with your tools",
    'and answer with the result; never send "hold on" or "let me check".',
    "",
    "A person talking to the user always gets an answer: match greetings and",
    "small talk in kind, and answer questions plainly and briefly in the",
    "user's casual voice, using your tools and memory where they help. When",
    "something is only the user's to decide (plans, commitments, money,",
    "personal or sensitive matters), do not decide it and do not go silent:",
    'send a light deferral in their voice, like "let me get back to you on',
    'that". Silence on a real message reads as the user ignoring them.',
    "",
    "Every message from an allowed sender gets an answer. Never decide that a",
    "sender is a business, a bot, a broadcast or spam and stay quiet. The",
    "user chose who you answer, and a name that looks like a company can be",
    "the user's own second number. The one exception is your own words",
    "echoing back to you: reply exactly NO_REPLY to those, and nothing is",
    "sent. Never use it for anything else.",
    "",
    "Never start new topics, make plans, or volunteer information the user",
    "has not asked you to handle. The user is not in this chat. They steer",
    "you from your main chat (check memory for their instructions about this",
    "person), and can read this conversation under your bot in the Bots",
    "pane. Their first message follows.",
  ].join(" ");

/** Set while the platform serves a first run on the house; every request of the run carries it as a header. */
export const sponsoredRunEnvUntil = (
  sponsoredUntil: number | null | undefined
): Record<string, string> =>
  sponsoredUntil != null && Date.now() < sponsoredUntil
    ? {
        ABACUSAI_BOT_SPONSORED_RUN: SPONSORED_RUN_MARKER,
        // The deadline too: a process outlives the window, and must stop
        // sending the marker when it passes rather than when it exits.
        ABACUSAI_BOT_SPONSORED_UNTIL: String(sponsoredUntil),
      }
    : {};

const sponsoredRunEnv = (bot: Bot): Record<string, string> =>
  sponsoredRunEnvUntil(bot.sponsoredUntil);

export class BotService {
  constructor(private readonly callbacks: BotServiceCallbacks) {}

  list(): Bot[] {
    return listBots();
  }

  create(input: BotCreateInput, id?: string): Bot {
    const bot = createBot(input, id);
    this.rewriteAllPersonas();
    this.callbacks.emitChanged();

    return bot;
  }

  /** The bot the user's own chat on this app goes to; null when unset or deleted. */
  homeBotId(app: HomeChannel): string | null {
    const id = this.callbacks.homeBots?.()[app] ?? null;
    return id != null && getBot(id) != null ? id : null;
  }

  /** The one setter: every way a chat app's home bot changes comes here. */
  setHomeBot(app: HomeChannel, botId: string): Bot {
    const bot = getBot(botId);
    if (bot == null)
      throw new EntityNotFoundError("bot", botId, `No bot with id "${botId}".`);
    if (this.homeBotId(app) === botId) return bot;
    this.callbacks.saveHomeBot?.(app, botId);
    // Every persona: the other bots name the home bot.
    this.rewriteAllPersonas();
    this.callbacks.emitChanged();
    return bot;
  }

  /**
   * The app's home bot, set when there is none (never set, or deleted): the
   * first bot made from the app's agent template, else a new one from it.
   */
  ensureHomeBot(app: HomeChannel): string {
    const current = this.homeBotId(app);
    if (current != null) return current;
    const first = listBots()
      .filter((bot) => bot.homeChannel === app)
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    const bot = first ?? this.createFromTemplate(agentTemplateFor(app));
    return this.setHomeBot(app, bot.id).id;
  }

  /** A bot made from a template, speaking first in its chat. */
  private createFromTemplate(template: BotTemplate): Bot {
    const bot = this.create({
      name: template.name,
      title: template.title,
      persona: template.persona,
      description: template.mission,
      avatarColor: template.avatarColor,
      avatarShape: template.avatarShape,
      homeChannel: template.homeChannel ?? null,
      templateId: template.id,
    });
    void this.openChat(bot.id).catch((error: unknown) => {
      console.error(`[bots] ${bot.name} failed to open its chat:`, error);
    });
    return bot;
  }

  /**
   * Older installs answered each self lane with a hidden "… AbacusAI Bot <->
   * You" bot (stamped with `channel`). It becomes that app's agent, history
   * kept, and its home bot unless the app has another. Idempotent: the
   * stamp it clears is what selects it.
   */
  adoptChannelBots(): void {
    let adopted = false;
    for (const bot of listBots()) {
      const app = HOME_CHANNELS.find((channel) => channel === bot.channel);
      if (app == null) continue;
      adopted = true;
      const template = agentTemplateFor(app);
      updateBot(bot.id, {
        name: template.name,
        title: template.title,
        persona: template.persona,
        description: template.mission,
        homeChannel: app,
        channel: null,
      });
      if (this.homeBotId(app) == null)
        this.callbacks.saveHomeBot?.(app, bot.id);
      console.log(`[bots] ${bot.id} adopted as the ${app} agent`);
    }
    if (adopted) this.rewriteAllPersonas();
  }

  /**
   * Tell the bot's chat what an edit changed. The session is started first: a
   * chat idle since the last launch has no process to deliver into.
   */
  async announceChange(id: string, notice: BotChangeNotice): Promise<void> {
    if (!notice.mission && !notice.persona && notice.checkIn == null) return;
    const bot = getBot(id);
    if (bot == null || bot.workspaceId == null || bot.sessionId == null) return;
    if (!this.callbacks.sessionExists(bot.workspaceId, bot.sessionId)) return;
    const started = await this.callbacks.startSession(
      bot.workspaceId,
      bot.sessionId
    );
    if (!started.success) return;
    this.callbacks.sendMessage(
      bot.workspaceId,
      bot.sessionId,
      changeNotice(notice),
      { operator: { kind: "mission-updated" } }
    );
  }

  update(id: string, changes: BotUpdateInput): Bot {
    const bot = updateBot(id, changes);
    // Every persona, not just this one: teammates cite its name and mission.
    this.rewriteAllPersonas();

    // The chat is named after the bot; a rename follows it.
    if (bot.workspaceId != null && bot.sessionId != null) {
      this.callbacks.updateSessionLabel(
        bot.workspaceId,
        bot.sessionId,
        bot.name
      );
    }
    // A model change (a reset to the app default included) reaches every
    // session the bot owns: persisted, and applied to the running ones.
    if (changes.model !== undefined) this.#track(this.repinBot(bot.id));
    this.callbacks.emitChanged();

    return bot;
  }

  /** Re-pins in flight (`update`), for callers that must see them land. */
  readonly #repins = new Set<Promise<void>>();

  #track(work: Promise<void>): void {
    this.#repins.add(work);
    void work.finally(() => this.#repins.delete(work));
  }

  /** Resolves once every re-pin started so far has landed. */
  async settled(): Promise<void> {
    while (this.#repins.size > 0) await Promise.all(this.#repins);
  }

  /** The sessions a bot owns: its forever chat and its sender chats. */
  ownedSessions(
    botId: string
  ): Array<{ workspaceId: string; sessionId: string }> {
    const bot = getBot(botId);
    const owned = new Map<string, { workspaceId: string; sessionId: string }>();
    if (bot?.workspaceId != null && bot.sessionId != null)
      owned.set(bot.sessionId, {
        workspaceId: bot.workspaceId,
        sessionId: bot.sessionId,
      });
    for (const chat of listSenderSessions())
      if (chat.botId === botId)
        owned.set(chat.sessionId, {
          workspaceId: chat.workspaceId,
          sessionId: chat.sessionId,
        });
    return [...owned.values()];
  }

  /** Every session the bot owns takes its effective model (spec 03 §24.10 d). */
  async repinBot(botId: string): Promise<void> {
    for (const owned of this.ownedSessions(botId)) {
      try {
        await this.pinSession(owned.sessionId, botId, owned.workspaceId);
      } catch (error) {
        console.error(
          `[bots] re-pinning ${owned.sessionId} failed: ${String(error)}`
        );
      }
    }
  }

  /** Per session, the pin in flight: pins of one session run one at a time. */
  readonly #pinning = new Map<string, Promise<string | null>>();

  /**
   * Pins a bot session to its bot's effective model when its stored one
   * differs (spec 03 §24.10 b, c): resolved from `bot.model` with the shared
   * resolver at every start and admission, so an app-default change reaches
   * a null-model bot even when no `openChat` runs. Returns the effective
   * model, or null for a session no bot owns (check-in runs keep their
   * routine's rules), a session gone meanwhile, or when nothing is runnable.
   *
   * The catalog read is async and a bot's model can change meanwhile, so
   * pins of one session are serialised, and a resolution whose `bot.model`
   * is no longer the bot's is thrown away and redone: two quick edits
   * resolving in reverse order still leave the session on the latest.
   */
  pinSession(
    sessionId: string,
    ownerBotId?: string,
    ownerWorkspaceId?: string
  ): Promise<string | null> {
    const before = this.#pinning.get(sessionId);
    const run = (before ?? Promise.resolve(null))
      .catch(() => null)
      .then(() => this.#pinNow(sessionId, ownerBotId, ownerWorkspaceId));
    this.#pinning.set(sessionId, run);
    void run
      .finally(() => {
        if (this.#pinning.get(sessionId) === run)
          this.#pinning.delete(sessionId);
      })
      .catch(() => undefined);
    return run;
  }

  async #pinNow(
    sessionId: string,
    ownerBotId?: string,
    ownerWorkspaceId?: string
  ): Promise<string | null> {
    const requestedOf = (bot: Bot): string | null =>
      bot.model != null && bot.model.length > 0 ? bot.model : null;
    // A bot edited again mid-resolution is resolved again; bounded, since
    // each round is a catalog read.
    for (let round = 0; round < 4; round += 1) {
      const info = this.callbacks.sessionInfo?.(sessionId) ?? null;
      // A session main no longer has takes no pin.
      if (this.callbacks.sessionInfo != null && info == null) return null;
      const botId =
        ownerBotId ??
        (info?.owner?.kind === "bot" ? info.owner.botId : null) ??
        botForSession(sessionId)?.id ??
        null;
      if (botId == null) return null;
      const bot = getBot(botId);
      if (bot == null) return null;
      const workspaceId = info?.workspaceId ?? ownerWorkspaceId;
      if (workspaceId == null) return null;
      const requested = requestedOf(bot);
      const model = await this.callbacks.effectiveModel(
        requested,
        info?.model ?? null
      );
      // Rechecked after the await: the session may be gone, the bot deleted
      // or its model changed.
      const after =
        this.callbacks.sessionInfo == null
          ? info
          : this.callbacks.sessionInfo(sessionId);
      if (this.callbacks.sessionInfo != null && after == null) return null;
      const botAfter = getBot(botId);
      if (botAfter == null) return null;
      if (requestedOf(botAfter) !== requested) continue;
      if (model == null || model.length === 0) return null;
      if (after == null || after.model !== model)
        this.callbacks.updateSessionModel(workspaceId, sessionId, model);
      return model;
    }
    return null;
  }

  /** Deleting a bot deletes its chat: the conversation *is* the bot. */
  delete(id: string): void {
    const bot = removeBot(id);

    if (bot.workspaceId != null && bot.sessionId != null) {
      try {
        this.callbacks.removeSession(bot.workspaceId, bot.sessionId);
      } catch {
        // The session may already be gone; the registry entry is what counts.
      }
    }
    // Sender sessions keep their transcripts (words already sent under the
    // user's name) but lose their routing entries.
    removeSenderSessionsForBot(id);
    this.callbacks.onBotRemoved?.(id);
    this.rewriteAllPersonas();
    this.callbacks.emitChanged();
  }

  /** Chats being minted right now, so concurrent opens share one session. */
  private readonly opening = new Map<string, Promise<BotChatHandle>>();

  /**
   * The bot's forever chat, created on first open or after its session died.
   * Fails closed on an unknown bot rather than minting a chat nothing owns.
   */
  async openChat(botId: string): Promise<BotChatHandle> {
    // Two racing opens would each mint a session and send the kickstart.
    const inFlight = this.opening.get(botId);
    if (inFlight != null) return inFlight;
    const open = this.openChatNow(botId).finally(() => {
      this.opening.delete(botId);
    });
    this.opening.set(botId, open);
    return open;
  }

  private async openChatNow(botId: string): Promise<BotChatHandle> {
    const bot = getBot(botId);
    if (bot == null)
      throw new EntityNotFoundError("bot", botId, `No bot with id "${botId}".`);

    // Every bot chat lives in the bot folder. A bot pinned elsewhere gets a
    // new chat here; the old transcript stays in that workspace's list.
    const workspaceId = await this.callbacks.resolveDefaultWorkspaceId();

    if (workspaceId == null)
      throw new Error("No workspace to open the bot's chat in.");

    // Reuse only a chat already in the bot folder; a deleted one is remade.
    if (
      bot.sessionId != null &&
      bot.workspaceId === workspaceId &&
      this.callbacks.sessionExists(workspaceId, bot.sessionId)
    ) {
      // A reused chat takes the effective model too (the app default may
      // have moved since it was pinned).
      await this.pinSession(bot.sessionId, botId, workspaceId);
      // A chat whose first start failed exists but never spoke: it is owed
      // the kickstart, once, when it next comes up.
      if (bot.kickstartedAt == null) {
        const started = await this.callbacks.startSession(
          workspaceId,
          bot.sessionId
        );
        if (started.success) {
          this.callbacks.sendMessage(
            workspaceId,
            bot.sessionId,
            await this.kickstart(bot),
            { operator: { kind: "kickstart" } }
          );
          markBotKickstarted(botId);
        }
      }
      return { botId, workspaceId, sessionId: bot.sessionId };
    }

    const session = this.callbacks.createSession(workspaceId, {
      kind: "bot",
      botId,
      role: "forever",
      key: null,
    });
    this.callbacks.updateSessionLabel(workspaceId, session.id, bot.name);
    // Pinned explicitly: an unpinned chat starts on the CLI's own fallback,
    // not the app default the session picker shows.
    await this.pinSession(session.id, botId, workspaceId);
    recordBotSession(botId, workspaceId, session.id);
    this.callbacks.emitChanged();

    // The kickstart makes the bot speak first; a failed start is not fatal
    // since the chat exists. Only for a bot that never had a chat: a remint
    // is the same conversation to the user, and would introduce itself again.
    const started = await this.callbacks.startSession(workspaceId, session.id);
    if (started.success && bot.sessionId == null) {
      this.callbacks.sendMessage(
        workspaceId,
        session.id,
        await this.kickstart(bot),
        { operator: { kind: "kickstart" } }
      );
      markBotKickstarted(botId);
    }

    return { botId, workspaceId, sessionId: session.id };
  }

  /**
   * The dedicated conversation a bot holds with one remote sender. Same
   * contract as openChat, except a fresh chat returns its preamble as `intro`
   * for the gateway to ride on the first prompt rather than a kickstart.
   */
  async openSenderChat(
    botId: string,
    platform: string,
    chatId: string,
    senderName: string
  ): Promise<BotChatHandle & { intro?: string }> {
    const bot = getBot(botId);
    if (bot == null)
      throw new EntityNotFoundError("bot", botId, `No bot with id "${botId}".`);

    const key = senderSessionKey(botId, platform, chatId);
    // "routine" is a route with no remote sender behind it, not a platform.
    const role: SessionOwner["role"] =
      platform === "routine" ? "routine" : "sender";
    // The owner stamp lives in the session store itself, so a registry row
    // lost to a wipe does not mint a duplicate conversation.
    const existing =
      getSenderSession(key) ??
      this.callbacks.findOwnedSession(botId, role, key);

    if (
      existing != null &&
      this.callbacks.isWorkspaceUsable(existing.workspaceId) &&
      this.callbacks.sessionExists(existing.workspaceId, existing.sessionId)
    ) {
      recordSenderSession(key, {
        botId,
        workspaceId: existing.workspaceId,
        sessionId: existing.sessionId,
        platform,
        senderName,
      });
      // Reused: re-pinned before anything runs on it (spec 03 §24.10 b).
      await this.pinSession(existing.sessionId, botId, existing.workspaceId);
      return {
        botId,
        workspaceId: existing.workspaceId,
        sessionId: existing.sessionId,
      };
    }

    const workspaceId = await this.callbacks.resolveDefaultWorkspaceId();
    if (workspaceId == null)
      throw new Error("No workspace to open the sender chat in.");

    const session = this.callbacks.createSession(workspaceId, {
      kind: "bot",
      botId,
      role,
      key,
      platform,
      senderName,
    });
    this.callbacks.updateSessionLabel(
      workspaceId,
      session.id,
      `${bot.name} ↔ ${senderName}`
    );
    await this.pinSession(session.id, botId, workspaceId);
    recordSenderSession(key, {
      botId,
      workspaceId,
      sessionId: session.id,
      platform,
      senderName,
    });
    this.callbacks.emitChanged();

    await this.callbacks.startSession(workspaceId, session.id);

    return {
      botId,
      workspaceId,
      sessionId: session.id,
      intro: senderChatIntro(senderName, platform),
    };
  }

  listSenderChats(): Array<{
    botId: string;
    workspaceId: string;
    sessionId: string;
    platform: string;
    senderName: string;
  }> {
    return listSenderSessions();
  }

  /** The bot whose forever chat is this session, or null. */
  botIdForSession(sessionId: string): string | null {
    return botForSession(sessionId)?.id ?? null;
  }

  /** A bot's forever chat, where the user is in the app. */
  isAppBotChat(sessionId: string): boolean {
    const bot = botForSession(sessionId);
    // A sender's chat runs the same bot but is that person's, not the owner's.
    return bot != null && bot.sessionId === sessionId;
  }

  /**
   * Extra agent env when this session is a bot's chat. ABACUSAI_BOT_BOT_DIR is
   * what flips the agent process into the bot loop.
   */
  personaEnvForSession(sessionId: string): Record<string, string> {
    const bot = botForSession(sessionId);
    if (bot == null) return {};

    // Rewritten at every spawn, so a lost persona file cannot strand the
    // session with a stale identity.
    this.writePersona(bot);

    return {
      ABACUSAI_BOT_PERSONA: personaPath(bot.id),
      ABACUSAI_BOT_BOT_DIR: botDir(bot.id),
      ...sponsoredRunEnv(bot),
    };
  }

  /** The first-run note, in the language replies resolve to (user-language.ts). */
  private async kickstart(bot: Bot): Promise<string> {
    const tag = this.callbacks.appLanguage?.() ?? null;
    if (tag == null)
      return kickstartMessage(bot, null, await channelWords("en-US"));
    const { name } = resolveReplyLanguage(readUserLanguage(), tag);
    const locale = channelLocale(name, null);
    return kickstartMessage(
      bot,
      locale === "en-US" ? name : nativeLanguageName(locale),
      await channelWords(locale)
    );
  }

  /** The sponsored-run marker for a routine session, which is the bot's work too; empty once the window has passed. */
  sponsoredRunEnvForBot(botId: string): Record<string, string> {
    const bot = getBot(botId);
    return bot == null ? {} : sponsoredRunEnv(bot);
  }

  private writePersona(bot: Bot, homes = this.homes()): void {
    const file = personaPath(bot.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${renderPersona(bot, homes)}\n`, "utf8");
    fs.renameSync(temp, file);
  }

  /** The home bots that exist, by app. */
  private homes(): Partial<Record<HomeChannel, Bot>> {
    const homes: Partial<Record<HomeChannel, Bot>> = {};
    for (const app of HOME_CHANNELS) {
      const id = this.homeBotId(app);
      const bot = id != null ? getBot(id) : null;
      if (bot != null) homes[app] = bot;
    }
    return homes;
  }

  /** Personas live on disk and running sessions re-read them per turn. */
  private rewriteAllPersonas(): void {
    const homes = this.homes();
    for (const bot of listBots()) this.writePersona(bot, homes);
  }
}
