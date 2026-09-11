/**
 * The bot lifecycle: persona files, the forever chat, and the first turn.
 * Given callbacks rather than the service host, so it stays testable and can
 * reach no further than it needs. The persona is a file the agent re-reads
 * per turn, so editing the bot updates a running chat without a respawn.
 */
import fs from "fs";
import path from "path";

import type {
  BotChangeNotice,
  Bot,
  BotChatHandle,
  BotCreateInput,
  BotUpdateInput,
} from "#shared/bots";
import type { SessionOwner } from "#shared/contracts";

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
    message: string
  ) => void;
  removeSession: (workspaceId: string, sessionId: string) => void;
  /** Pin the chat to the bot's model, so restarts keep it. */
  updateSessionModel: (
    workspaceId: string,
    sessionId: string,
    model: string
  ) => void;
  /** The model the app would pick for a chat of its own; see openChat. */
  defaultModel: () => string | null;
  emitChanged: () => void;
  /**
   * Tear down what a deleted bot owned outside this service: an orphaned
   * routine would fire into a fresh anonymous session.
   */
  onBotRemoved?: (botId: string) => void;
}

/**
 * The bot's standing prompt, framed like custom instructions and explicit
 * that the persona does not widen permissions.
 */
const renderPersona = (bot: Bot): string => {
  const role = bot.title.length > 0 ? bot.title : "assistant";

  return [
    `# ${bot.name}`,
    "",
    `**Role:** ${role}`,
    `**Your mission — yours alone:** ${bot.description}`,
    // Its own line so the model reads the voice as manner, not more mission.
    ...(bot.persona.length > 0
      ? [`**Your voice — how you speak, every message:** ${bot.persona}`]
      : []),
    "",
    `You are ${bot.name}, a persistent named agent. This conversation is your`,
    "single ongoing chat with your user: it keeps its history across restarts,",
    "so treat it as a continuing working relationship, not a one-off session.",
    `If the user asks your name, answer "${bot.name}".`,
    "",
    "Stay in character and keep your mission in view. On the very first turn",
    "of the chat, greet the user briefly in your own voice and propose a few",
    "concrete things you can do for them based on your role — but if your",
    "mission already gives you a concrete assignment, treat that as what you",
    "were created to do: skip the getting-started questions and begin.",
    "",
    // Nothing wakes a bot at an hour unless a routine does, and only the bot
    // can turn its own mission into one.
    "If your mission names a time or a rhythm — every day at 10 am, weekday",
    "mornings, every hour — that is a routine, not a promise. Before anything",
    "else on your first turn, create it with the cronjob tool: the schedule",
    "in cron, the recurring part of your mission as the prompt. It runs once",
    "on creation, which is your first pass; do not do the pass by hand as",
    "well. Confirm to the user that it is set and when it fires next. Nothing",
    "will bring you back at that hour unless the routine exists, so never say",
    'you will "check again tomorrow" unless the routine that will is listed.',
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
    "the chat apps that are connected — sending a WhatsApp update, answering a",
    "client on Telegram — working inside the tools that are attached, running",
    "on a schedule so a job happens without being asked, and reading, editing",
    "and running things in the workspace folder. Check which connectors are",
    "actually attached before naming one, and offer to connect what is missing",
    "rather than assuming it.",
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
    "introduce yourself again, and do not carry out your mission now — " +
    "wait to be asked, or for the next check-in."
  );
};

/** Visible first message of a fresh bot chat, so the bot speaks first. */
const KICKSTART_MESSAGE =
  "[first run] Introduce yourself once, then get started on your mission. " +
  "Everything after a tool result is the same reply continuing — no second " +
  "greeting, no restating the mission.";

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
    "reply with exactly what should be sent, and nothing else — no status",
    "notes, no commentary, no questions meant for the user, no introducing",
    "yourself. Put the words to send inside <reply></reply> — ONLY what is",
    "inside that tag is delivered; think, plan or note anything outside it.",
    "Nothing runs after your reply — there is no later — so anything that",
    "needs looking up (weather, a search, a date) you do NOW with your tools",
    'and answer with the result; never send "hold on" or "let me check".',
    "",
    "A person talking to the user always gets an answer: match greetings and",
    "small talk in kind, and answer questions plainly and briefly in the",
    "user's casual voice, using your tools and memory where they help. When",
    "something is only the user's to decide — plans, commitments, money,",
    "personal or sensitive matters — do not decide it and do not go silent:",
    'send a light deferral in their voice, like "let me get back to you on',
    'that". Silence on a real message reads as the user ignoring them.',
    "",
    "Every message from an allowed sender gets an answer. Never decide that a",
    "sender is a business, a bot, a broadcast or spam and stay quiet — the",
    "user chose who you answer, and a name that looks like a company can be",
    "the user's own second number. The one exception is your own words",
    "echoing back to you: reply exactly NO_REPLY to those, and nothing is",
    "sent. Never use it for anything else.",
    "",
    "Never start new topics, make plans, or volunteer information the user",
    "has not asked you to handle. The user is not in this chat — they steer",
    "you from your main chat (check memory for their instructions about this",
    "person), and can read this conversation under your bot in the Bots",
    "pane. Their first message follows.",
  ].join(" ");

export class BotService {
  constructor(private readonly callbacks: BotServiceCallbacks) {}

  list(): Bot[] {
    return listBots();
  }

  create(input: BotCreateInput): Bot {
    const bot = createBot(input);
    this.rewriteAllPersonas();
    this.callbacks.emitChanged();

    return bot;
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
      changeNotice(notice)
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
      // A model change lands when the chat next (re)starts.
      if (changes.model !== undefined && bot.model != null)
        this.callbacks.updateSessionModel(
          bot.workspaceId,
          bot.sessionId,
          bot.model
        );
    }
    this.callbacks.emitChanged();

    return bot;
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
    if (bot == null) throw new Error(`No bot with id "${botId}".`);

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
    const model =
      bot.model != null && bot.model.length > 0
        ? bot.model
        : this.callbacks.defaultModel();
    if (model != null && model.length > 0)
      this.callbacks.updateSessionModel(workspaceId, session.id, model);
    recordBotSession(botId, workspaceId, session.id);
    this.callbacks.emitChanged();

    // The kickstart makes the bot speak first; a failed start is not fatal
    // since the chat exists. Only for a bot that never had a chat: a remint
    // is the same conversation to the user, and would introduce itself again.
    const started = await this.callbacks.startSession(workspaceId, session.id);
    if (started.success && bot.sessionId == null) {
      this.callbacks.sendMessage(workspaceId, session.id, KICKSTART_MESSAGE);
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
    if (bot == null) throw new Error(`No bot with id "${botId}".`);

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
    const model =
      bot.model != null && bot.model.length > 0
        ? bot.model
        : this.callbacks.defaultModel();
    if (model != null && model.length > 0)
      this.callbacks.updateSessionModel(workspaceId, session.id, model);
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
    };
  }

  private writePersona(bot: Bot): void {
    const file = personaPath(bot.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${renderPersona(bot)}\n`, "utf8");
    fs.renameSync(temp, file);
  }

  /** Personas live on disk and running sessions re-read them per turn. */
  private rewriteAllPersonas(): void {
    for (const bot of listBots()) this.writePersona(bot);
  }
}
