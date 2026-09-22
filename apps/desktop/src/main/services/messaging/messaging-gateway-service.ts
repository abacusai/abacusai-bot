import { AgentMode, AgentStatus } from "#shared/agent-types";
import type { DesktopEvent } from "#shared/agent-types";
import type {
  AgentSessionListItem,
  StartAgentSessionResult,
} from "#shared/contracts";
import {
  MESSAGING_PLATFORM_CATALOG,
  SHARED_BOT_PLATFORM_OF,
  messagingPlatformSpec,
  redactSecret,
  type MessagingPlatformId,
  type MessagingPlatformInfo,
  type MessagingPlatformState,
  type MessagingSnapshot,
  type SharedChannelLink,
} from "#shared/messaging";

import { readDefaultAgentMode } from "../config/settings";
import { environmentNoticeService } from "../providers/environment-notice-service";
import { AbacusChannelsConnector } from "./abacus-channels-connector";
import { forChat } from "./chat-markdown";
import { backoffDelayMs, looksLikeBotOutput } from "./connector";
import type { InboundMessage, MessagingConnector } from "./connector";
import { DiscordWebConnector } from "./discord-web-connector";
import {
  approvePairing,
  pausePairing,
  approvedUserIds,
  findPairing,
  isFieldFromEnv,
  isPlatformConfigured,
  isPlatformEnabled,
  listPairing,
  readFieldValue,
  readGatewaySettings,
  readStoredMessageLog,
  recordPairingRequest,
  revokePairing,
  saveGatewaySettings,
  savePlatformValues,
  setPlatformEnabled,
  writeStoredMessageLog,
} from "./messaging-config-service";
import type { SenderCandidate } from "./sender-resolution";
import { TelegramWebConnector } from "./telegram-web-connector";
import { WhatsAppWebConnector } from "./whatsapp-web-connector";

/**
 * The messaging gateway: connectors in, agent turns out. A connector hands it
 * a normalised message; it gates the sender, finds or creates the agent
 * session for that conversation (`platform:chatId`), runs the turn and sends
 * the answer back. Pairing is the security boundary: an approved sender runs
 * an agent with tool access, and nothing reaches the agent before a human
 * approves the sender in the Connectors settings. There is no "open" mode.
 */

/** Replies longer than this are almost always the agent dumping a file. */
const MAX_REPLY_LENGTH = 12_000;

/**
 * Phrases that only appear once a reply is addressed to the user instead of
 * the contact. Few and machine-shaped: a false positive replaces a real
 * answer with a deferral, so nothing here is what a person texts a friend.
 */
const COMMENTARY_MARKERS: Array<[RegExp, string]> = [
  [/\bauto[- ]?reply\b/i, "auto-reply"],
  [/\bNO_REPLY\b/, "NO_REPLY"],
  [/\bthe user\b/i, "the user"],
  [/\byour (?:whatsapp|telegram|discord) (?:setup|account)\b/i, "your setup"],
  [/\bin your (?:casual )?voice\b/i, "in your voice"],
  [/\breply in your voice\b/i, "in your voice"],
];

const commentaryMarker = (reply: string): string | null =>
  COMMENTARY_MARKERS.find(([pattern]) => pattern.test(reply))?.[1] ?? null;

/** What goes instead: the deferral the preamble already asks for. */
const DEFERRAL = "let me get back to you on that";

/** Who the transcript's second bubble is from, matching the sender's label. */
const RESPONSE_LABEL = "[Response from AbacusAI Bot]";
/** What a phone hears when the desktop has no model to answer with. */
const NO_MODEL_REPLY =
  "The desktop app is not signed in to Abacus.AI right now. Open the app and sign in, then message me again.";

/**
 * The words for the other person, out of everything the model wrote. Asking
 * a model not to think aloud does not work; asking it to wrap the reply in
 * <reply>…</reply> does, and is checkable: only the last such block is sent.
 * Without a block the whole text goes, minus any <thinking> block, because a
 * reply must never be lost to a missing tag.
 */
const REPLY_TAG = /<reply>([\s\S]*?)<\/reply>/gi;
const THINKING_BLOCK =
  /<(?:thinking|think|reasoning)>[\s\S]*?<\/(?:thinking|think|reasoning)>/gi;

export const outgoingWords = (text: string): string => {
  const wrapped = [...text.matchAll(REPLY_TAG)];
  const last = wrapped.at(-1)?.[1];
  const chosen = last != null ? last : text.replace(THINKING_BLOCK, "");
  return chosen.trim();
};

/** The last complete <reply> block in `text`, or null when there is none. */
export const lastTaggedReply = (text: string): string | null => {
  const wrapped = [...text.matchAll(REPLY_TAG)];
  const last = wrapped.at(-1)?.[1];
  return last == null ? null : last.trim();
};

/** The one rule, restated on every auto-reply turn. See dispatch. */
const REPLY_REMINDER =
  "[auto-reply] Everything you write here is delivered to them as if the " +
  "user typed it. Reply with only the words to send — never notes, " +
  "questions or options meant for the user, who is not in this chat. " +
  "Put the words to send inside <reply></reply>. ONLY what is inside that " +
  "tag is delivered; think, plan or note anything outside it. Nothing runs " +
  "after your reply, so anything that needs looking up — weather, a " +
  "search, a date — do it now with your tools and answer with the result; " +
  'never send "hold on" or "let me check".';

/**
 * How many messages may wait behind a running turn. Every queued message
 * becomes a billed agent turn, so an unbounded queue is a spending leak. Past
 * the cap the sender is told once rather than silently dropped.
 */
const MAX_QUEUED_MESSAGES = 20;

/**
 * How long a route may stay busy before an inbound message resets it. A turn
 * stopped from the desktop never delivers its idle event here, so without
 * this the route stays busy forever. The host forces idle after 10 minutes.
 */
const BUSY_RESET_MS = 15 * 60 * 1000;

/**
 * How long a platform may sit in `connecting` before it is called a failure.
 * Bounded on the state, not on `start()`, which can resolve before the socket
 * says hello. Ceilings for "never going to answer", not latency targets.
 */
const CONNECT_DEADLINE_MS: Partial<Record<MessagingPlatformId, number>> = {
  // Empty: every current platform reaches `connected` on a human's scan,
  // which no timer should bound. Kept for one that connects on its own.
};

/**
 * How long a connector gets to shut down before the gateway stops waiting.
 * `stop()` is awaited into the IPC call behind Save and the enable toggle, so
 * one that never finishes parks the whole pane on "Saving…". Past the deadline
 * it is abandoned, not killed: its generation is retired, so nothing it still
 * holds can reach the pane or start a turn.
 */
const STOP_DEADLINE_MS = 5_000;

type GatewayOptions = {
  /** Workspace remote messages run in; null when none is configured. */
  resolveWorkspaceId: () => string | null;
  createAgentSession: (workspaceId: string) => AgentSessionListItem;
  updateSessionLabel: (
    workspaceId: string,
    sessionId: string,
    label: string
  ) => void;
  startSession: (
    workspaceId: string,
    sessionId: string,
    mode: AgentMode
  ) => Promise<StartAgentSessionResult>;
  sendMessage: (
    workspaceId: string,
    sessionId: string,
    message: string
  ) => void;
  /**
   * Show the incoming message in the session's transcript. The composer echoes
   * a local user's message; a remote turn never touches it, so without this
   * the session reads as the agent talking to itself.
   */
  emitUserMessage: (
    workspaceId: string,
    sessionId: string,
    content: string
  ) => void;
  /**
   * Show the words that actually went to the remote chat. The turn's own text
   * is the model thinking out loud around a <reply> tag, which is hidden from
   * the transcript, so this is what stands in for the agent's answer.
   */
  emitAgentMessage?: (
    workspaceId: string,
    sessionId: string,
    content: string
  ) => void;
  /** Broadcast so the Messaging pane re-reads its snapshot. */
  emitChanged: () => void;
  /**
   * A platform started or stopped, so the messaging tools just came or went.
   * For the running agent, not the pane: the send tools are withheld from
   * `tools/list` while no platform runs.
   */
  onToolAvailabilityChanged?: () => void;
  /** Create the self-lane bot for one platform; once ever per lane. */
  createAutoReplyBot?: (platform: SelfLanePlatform) => string | null;
  /** Resolve a bot's forever chat, creating or reviving it as needed. */
  openBotChat?: (
    botId: string
  ) => Promise<{ botId: string; workspaceId: string; sessionId: string }>;
  /**
   * Remove every bot conversation with one remote chat, history included, so
   * a deleted auto-reply leaves nothing for the next message to land in.
   */
  forgetSenderChats?: (platform: MessagingPlatformId, chatId: string) => void;
  /**
   * The bot's dedicated conversation with one remote chat, where sender-routed
   * turns run. Everything a turn says goes back to the sender, so it must be
   * a room where the sender is the only audience.
   */
  openBotSenderChat?: (
    botId: string,
    platform: MessagingPlatformId,
    chatId: string,
    senderName: string
  ) => Promise<{
    botId: string;
    workspaceId: string;
    sessionId: string;
    /**
     * Present when the conversation was freshly minted: the rules-of-the-room
     * preamble, which must ride on the first dispatched prompt rather than
     * race it as a message of its own.
     */
    intro?: string;
  }>;
};

/**
 * Platforms whose own chat with the user gets a dedicated bot on link, keyed
 * by platform in `selfBotIds`. The older single `selfBotId` slot belonged to
 * the retired own-account Telegram bootstrap.
 */
export type SelfLanePlatform =
  | "abacus_discord"
  | "abacus_telegram"
  | "whatsapp";
const SELF_LANES: readonly SelfLanePlatform[] = [
  "abacus_discord",
  "abacus_telegram",
  "whatsapp",
];
const isSelfLane = (
  platformId: MessagingPlatformId
): platformId is SelfLanePlatform =>
  (SELF_LANES as readonly MessagingPlatformId[]).includes(platformId);

/**
 * Which bot answers the user's own chat on a platform. Each lane reads its
 * own slot, so a Discord DM never lands in the user's Telegram conversation;
 * WhatsApp with an empty slot falls back to the older single slot until
 * relinked.
 */
const selfBotFor = (
  settings: ReturnType<typeof readGatewaySettings>,
  platformId: MessagingPlatformId
): string | null => {
  if (isSelfLane(platformId)) {
    const own = settings.selfBotIds?.[platformId] ?? null;
    if (own != null || platformId !== "whatsapp") return own;
  }
  return settings.selfBotId ?? settings.botId;
};

/** One message the gateway saw, kept for the read_chat_messages tool. */
type ChatLogEntry = {
  platform: MessagingPlatformId;
  chatId: string;
  userId: string;
  userName: string | null;
  text: string;
  direction: "in" | "out";
  at: string;
};

/**
 * How much traffic to remember. Not an archive, but persisted across
 * restarts: a live read needs a chat to be named, so this log is the only
 * answer to "what came in" asked broadly.
 */
const MESSAGE_LOG_LIMIT = 500;
/** Rows list_chats shows at most, and the least any one platform keeps. */
const CHAT_LIST_CAP = 100;
const CHAT_LIST_PLATFORM_FLOOR = 20;

/**
 * How long a tool call waits for a platform that is still starting. Matches
 * the tool's own "try again in about twenty seconds"; longer holds every tool
 * call of a bot while a just-linked WhatsApp syncs.
 */
const READY_WAIT_MS = 20_000;
const READY_POLL_MS = 500;
/** How long the card may say "Syncing" before it is left to the next event. */
const SYNC_WATCH_MAX_MS = 5 * 60_000;
const SYNC_WATCH_POLL_MS = 2_000;

/** How long appendLog batches writes before the log touches disk. */
const MESSAGE_LOG_SAVE_DELAY_MS = 1_000;

/** A conversation in flight: which session it owns and what it's waiting on. */
type Route = {
  platform: MessagingPlatformId;
  chatId: string;
  sessionId: string;
  workspaceId: string;
  /** Approved sender who owns this conversation, so revoking can find it. */
  userId: string;
  replyContext?: Record<string, string>;
  /**
   * Text of the turn's latest assistant message only. Narration before a
   * tool call is the model talking to itself; only the last message is the
   * reply.
   */
  buffer: string;
  /** Which assistant message the buffer is from — see handleAgentEvent. */
  bufferMessageId: string | null;
  /**
   * A complete <reply> block written earlier in the turn, kept when a tool
   * round clears the buffer: a model that answers and then files a memory
   * note ends its turn with an empty buffer.
   */
  taggedReply: string | null;
  /** True between sending a prompt and the turn reaching idle or error. */
  busy: boolean;
  /** When the current turn was dispatched, for stuck-turn recovery. */
  busySince: number;
  /** Messages that arrived mid-turn, sent in order once the turn finishes. */
  queue: Array<{ text: string; replyContext?: Record<string, string> }>;
  /** Whether this turn has already said the queue is full. */
  queueFullNotified: boolean;
  /**
   * True when this route delivers into a bot's forever chat. Bot routes for
   * different chats share one session, so busyness is judged per session and
   * prompts carry the sender, not just the text.
   */
  viaBot: boolean;
  /** The sender line prefixed to prompts on bot routes. */
  senderLabel: string;
  /** Rules preamble still owed to the first dispatched prompt, then cleared. */
  pendingIntro: string | null;
};

/** How long a login probe may take before the last known state is used. */
const PROBE_LIVE_TIMEOUT_MS = 3000;

export class MessagingGatewayService {
  private readonly connectors = new Map<
    MessagingPlatformId,
    MessagingConnector
  >();
  private readonly states = new Map<
    MessagingPlatformId,
    { state: MessagingPlatformState; error: string | null }
  >();
  /** `platform:chatId` -> route. */
  private readonly routes = new Map<string, Route>();
  /** sessionId -> route, for the NDJSON hot path. */
  private readonly routesBySession = new Map<string, Route>();
  /**
   * In-flight route creation per `platform:chatId`, so two messages arriving
   * together share one session instead of racing `ensureRoute` into two.
   */
  private readonly pendingRoutes = new Map<string, Promise<Route | null>>();

  /**
   * Which attempt currently owns each platform. A stopped connector keeps
   * talking for a while (queued frames, a parked poll), through callbacks that
   * name only the platform; each callback is stamped with its attempt and
   * dropped once superseded, so it cannot overwrite a newer attempt's state or
   * start a turn for a platform the user switched off.
   */
  private readonly generations = new Map<MessagingPlatformId, number>();

  /** Armed while a platform is connecting; see CONNECT_DEADLINE_MS. */
  private readonly connectDeadlines = new Map<
    MessagingPlatformId,
    NodeJS.Timeout
  >();

  /** Everything seen and sent, oldest first, reloaded from the last run. */
  private readonly messageLog: ChatLogEntry[] =
    readStoredMessageLog() as ChatLogEntry[];

  /** Armed by appendLog; one write covers a burst of messages. */
  private logSaveTimer: NodeJS.Timeout | null = null;

  /**
   * Errored connectors are restarted on a growing delay, not on every sync.
   * Cleared the moment a platform connects, so a real recovery starts the
   * ladder over.
   */
  private readonly restartBackoff = new Map<
    MessagingPlatformId,
    { attempts: number; notBefore: number }
  >();

  constructor(private readonly options: GatewayOptions) {}

  /**
   * Bring every enabled+configured platform up. Called once at startup and
   * again whenever credentials or enable flags change.
   */
  async syncConnectors(): Promise<void> {
    const { gatewayEnabled } = readGatewaySettings();

    for (const entry of MESSAGING_PLATFORM_CATALOG) {
      const shouldRun =
        gatewayEnabled &&
        isPlatformEnabled(entry.id) &&
        isPlatformConfigured(entry.id);

      // A connector that died terminally still sits in the map looking
      // "running". Evict it so it restarts, on a backoff rather than on every
      // sync. `needs_login` is healthy and is never evicted.
      if (
        shouldRun &&
        this.connectors.has(entry.id) &&
        this.states.get(entry.id)?.state === "error" &&
        Date.now() >= (this.restartBackoff.get(entry.id)?.notBefore ?? 0)
      ) {
        const attempts = (this.restartBackoff.get(entry.id)?.attempts ?? 0) + 1;
        this.restartBackoff.set(entry.id, {
          attempts,
          notBefore: Date.now() + backoffDelayMs(attempts),
        });
        await this.stopPlatform(entry.id);
      }

      const isRunning = this.connectors.has(entry.id);

      if (shouldRun && !isRunning) this.startPlatform(entry.id);
      else if (!shouldRun && isRunning) await this.stopPlatform(entry.id);
    }

    this.options.emitChanged();
  }

  async dispose(): Promise<void> {
    if (this.logSaveTimer != null) {
      clearTimeout(this.logSaveTimer);
      this.logSaveTimer = null;
      this.saveLog();
    }
    await Promise.all(
      [...this.connectors.keys()].map((id) => this.stopPlatform(id))
    );
  }

  /**
   * Bring one platform up without making anyone wait for the network: the
   * enable toggle is disabled while its IPC call is in flight, and a host that
   * never answers would freeze it. The pane learns the outcome via setState.
   */
  private startPlatform(platformId: MessagingPlatformId): void {
    const connector = this.buildConnector(platformId);
    if (connector == null) return;

    // Registered before starting, so a sync that lands mid-handshake sees it as
    // running rather than starting a second one.
    this.connectors.set(platformId, connector);
    // On registration, not on `connected`: this is the set the tool gate reads.
    this.options.onToolAvailabilityChanged?.();
    this.setState(platformId, "connecting");
    this.armConnectDeadline(platformId, connector);

    void connector.start().catch(async (error: unknown) => {
      // Only if this attempt still owns the slot; a superseded attempt's
      // failure would overwrite the newer attempt's state.
      if (this.connectors.get(platformId) !== connector) return;

      await this.failPlatform(
        platformId,
        connector,
        error instanceof Error ? error.message : String(error)
      );
    });
  }

  /**
   * Give up on a platform, releasing whatever it had opened. Dropped rather
   * than retried: the common cause is a bad credential, and a retry loop would
   * hide the error the pane is trying to show.
   */
  private async failPlatform(
    platformId: MessagingPlatformId,
    connector: MessagingConnector,
    message: string
  ): Promise<void> {
    if (this.connectors.get(platformId) !== connector) return;

    this.connectors.delete(platformId);
    this.options.onToolAvailabilityChanged?.();
    // Retired before stopping, so the connector's own `disabled` on the way out
    // is dropped rather than landing between here and the error below.
    this.generations.set(
      platformId,
      (this.generations.get(platformId) ?? 0) + 1
    );

    // A start can fail halfway with resources already live (an IMAP client with
    // a reconnect handler, say) — stop() is what releases them.
    await this.awaitStop(connector);

    // Logged, not just shown: the pane's string is overwritten by the next
    // attempt, and a log dump must still show the failure.
    console.log(`[messaging] ${platformId}: failed — ${message}`);
    this.setState(platformId, "error", message);
  }

  private armConnectDeadline(
    platformId: MessagingPlatformId,
    connector: MessagingConnector
  ): void {
    const deadline = CONNECT_DEADLINE_MS[platformId];
    if (deadline == null) return;

    this.clearConnectDeadline(platformId);
    const timer = setTimeout(() => {
      this.connectDeadlines.delete(platformId);
      void this.failPlatform(
        platformId,
        connector,
        `${platformLabel(platformId)} did not finish connecting within ${Math.round(deadline / 1000)}s. ` +
          "Check the host and port, and any firewall between here and it."
      );
    }, deadline);
    // Never a reason to hold the process open: if everything else has finished,
    // there is nothing left for this to report to.
    timer.unref?.();
    this.connectDeadlines.set(platformId, timer);
  }

  private clearConnectDeadline(platformId: MessagingPlatformId): void {
    const timer = this.connectDeadlines.get(platformId);
    if (timer == null) return;
    clearTimeout(timer);
    this.connectDeadlines.delete(platformId);
  }

  private async stopPlatform(platformId: MessagingPlatformId): Promise<void> {
    const connector = this.connectors.get(platformId);
    this.connectors.delete(platformId);
    this.options.onToolAvailabilityChanged?.();
    // Retire this attempt's callbacks even if there is no connector to stop:
    // a start that is still resolving belongs to the generation being ended.
    this.generations.set(
      platformId,
      (this.generations.get(platformId) ?? 0) + 1
    );
    this.clearConnectDeadline(platformId);
    if (connector == null) return;

    await this.awaitStop(connector);
    this.setState(platformId, "disabled");
  }

  /** Give a connector STOP_DEADLINE_MS to shut down, then move on. */
  private async awaitStop(connector: MessagingConnector): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        connector.stop(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, STOP_DEADLINE_MS);
          // Nothing to report to if everything else has finished.
          timer.unref?.();
        }),
      ]);
    } catch {
      // Nothing useful to do if a connector fails to shut down cleanly.
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  }

  private buildConnector(
    platformId: MessagingPlatformId
  ): MessagingConnector | null {
    const generation = (this.generations.get(platformId) ?? 0) + 1;
    this.generations.set(platformId, generation);
    const current = (): boolean =>
      this.generations.get(platformId) === generation;

    const callbacks = {
      onMessage: (message: InboundMessage) => {
        // A stopped connector must not reach the agent. Its socket can still
        // hold a frame that arrived before the close completed, and routing it
        // would start a turn on behalf of a platform that is switched off.
        if (!current()) return;
        void this.handleInbound(platformId, message).catch((error: unknown) => {
          console.error(`[messaging] ${platformId} inbound failed:`, error);
        });
      },
      onState: (state: MessagingPlatformState, errorMessage?: string) => {
        if (!current()) return;
        this.setState(platformId, state, errorMessage);
      },
      onLog: (line: string) => {
        console.log(`[messaging] ${line}`);
      },
      onSelfLinked: () => {
        if (!current()) return;
        if (isSelfLane(platformId)) this.maybeBootstrapSelfLane(platformId);
      },
    };

    switch (platformId) {
      case "telegram":
        return new TelegramWebConnector(callbacks);
      case "discord":
        return new DiscordWebConnector(callbacks);
      case "whatsapp":
        return new WhatsAppWebConnector(callbacks);
      case "abacus_discord":
        return new AbacusChannelsConnector(callbacks, "discord");
      case "abacus_telegram":
        return new AbacusChannelsConnector(callbacks, "telegram");
      default:
        return null;
    }
  }

  private setState(
    platformId: MessagingPlatformId,
    state: MessagingPlatformState,
    error?: string
  ): void {
    // The login poll re-reports an unchanged state every tick; nobody
    // downstream needs to hear it again.
    const previous = this.states.get(platformId);
    if (previous?.state === state && previous.error === (error ?? null)) return;

    // Leaving `connecting` at all — connected, failed, switched off — settles
    // the question the deadline was asking.
    if (state !== "connecting") this.clearConnectDeadline(platformId);
    // A connector that made it back up has earned a fresh restart ladder.
    if (state === "connected") this.restartBackoff.delete(platformId);
    // Every transition to the main log, so an export says what the card showed.
    console.log(
      `[messaging] ${platformId}: ${previous?.state ?? "(new)"} -> ${state}` +
        (error != null && error.length > 0 ? ` (${error})` : "")
    );
    this.states.set(platformId, { state, error: error ?? null });
    this.watchSync(platformId, state);

    // The environment notice tells every conversation what it can reach; a
    // link that broke or came up mid-chat has to reach them the same way.
    if ((previous?.state === "connected") !== (state === "connected"))
      environmentNoticeService.markChanged();

    this.options.emitChanged();
  }

  // ---------------------------------------------------------------------------
  // Inbound routing
  // ---------------------------------------------------------------------------

  /** Recent inbound arrival times per chat, for the loop breaker. */
  private readonly inboundBurst = new Map<string, number[]>();

  /**
   * Has this chat produced more inbound turns than a person plausibly would?
   * Deliberately dumb: it is the backstop for the echo and sender guards, and
   * has to hold when one of them is wrong in a way nobody predicted.
   */
  /** Said once per pause, not once per message. */
  private pauseNoticed = false;

  private tooFastToBeReal(
    platformId: MessagingPlatformId,
    chatId: string,
    isSelf = false
  ): boolean {
    const key = `${platformId}:${chatId}`;
    const now = Date.now();
    const recent = (this.inboundBurst.get(key) ?? []).filter(
      (at) => now - at < SELF_LOOP_WINDOW_MS
    );
    recent.push(now);
    this.inboundBurst.set(key, recent);

    const lastMinute = recent.filter((at) => now - at < LOOP_WINDOW_MS);
    return (
      lastMinute.length > LOOP_BURST ||
      (isSelf && recent.length > SELF_LOOP_BURST)
    );
  }

  private async handleInbound(
    platformId: MessagingPlatformId,
    message: InboundMessage
  ): Promise<void> {
    // Saved media rides into the text as paths, so the log, the prompt and
    // the agent all see where the file is instead of "📷 Photo".
    if (message.attachments != null && message.attachments.length > 0) {
      const lines = message.attachments.map(
        (file) => `[attachment: ${file.name} saved to ${file.path}]`
      );
      message = {
        ...message,
        text: [message.text, ...lines]
          .filter((part) => part.length > 0)
          .join("\n"),
      };
    }
    this.appendLog({
      platform: platformId,
      chatId: message.chatId,
      userId: message.userId,
      userName: message.userName,
      text: message.text,
      direction: "in",
      at: new Date().toISOString(),
    });

    // The own-account Discord lane also sees the DM with the shared Abacus AI
    // bot: its answers are this app's own words coming back, never a sender
    // to pair or answer. Logged above, routed nowhere.
    if (this.isSharedBotChat(platformId, message.userName)) return;

    const settings = readGatewaySettings();
    const selfId = this.connectors.get(platformId)?.selfChatId?.() ?? null;
    const isSelf = selfId != null && selfId === message.userId;

    const selfBot = selfBotFor(settings, platformId);

    // Another AbacusBot's reply in the user's own chat is not the user
    // talking. The connector drops the signed ones; this catches the rest.
    if (isSelf && looksLikeBotOutput(message.text)) {
      console.log(
        `[messaging] ${platformId}: a message in the user's own chat reads as another bot's output — not answering it`
      );
      return;
    }

    // Listening is the opt-in: off, a message is logged, the sender stored
    // approved (nothing to gate) and no turn runs. The user's own chat is
    // exempt; the switch governs other people.
    if (!settings.respondToInbound && !(isSelf && selfBot != null)) {
      recordPairingRequest({
        platform: platformId,
        userId: message.userId,
        userName: message.userName,
        chatId: message.chatId,
        firstMessage: message.text,
      });
      approvePairing(platformId, message.userId);
      this.options.emitChanged();
      return;
    }

    // Still inside a cool-off from the breaker below. Messages are logged;
    // when it lapses the lane answers again with nothing to re-enable.
    if (Date.now() < settings.autoReplyPausedUntil) {
      if (!this.pauseNoticed) {
        this.pauseNoticed = true;
        console.log(
          "[messaging] auto-reply is paused after a suspected loop — messages are logged, not answered"
        );
      }
      return;
    }
    this.pauseNoticed = false;

    // A runaway conversation stops itself. No text-matching echo guard can be
    // trusted never to miss, so this one only counts turns per chat. Past the
    // burst auto-reply holds for a cool-off and then answers again: the bot
    // and the switch are left exactly as the user set them, because a false
    // positive here used to silence the lane for good, and getting it back
    // meant knowing which stored id had been set to null.
    if (this.tooFastToBeReal(platformId, message.chatId, isSelf)) {
      saveGatewaySettings({ autoReplyPausedUntil: Date.now() + LOOP_PAUSE_MS });
      // The count starts over with the cool-off, or the first message after
      // it would still be standing in the burst that caused the pause and
      // would pause the lane again, and again.
      this.inboundBurst.delete(`${platformId}:${message.chatId}`);
      console.log(
        `[messaging] auto-reply paused for ${Math.round(LOOP_PAUSE_MS / 60_000)} min: ` +
          `${platformId}:${message.chatId} sent ` +
          (isSelf
            ? `over ${SELF_LOOP_BURST} messages inside ${Math.round(SELF_LOOP_WINDOW_MS / 60_000)} min, `
            : `over ${LOOP_BURST} messages inside ${Math.round(LOOP_WINDOW_MS / 1000)}s, `) +
          "which reads as a reply loop rather than a conversation"
      );
      this.options.emitChanged();
      return;
    }

    const approved = approvedUserIds(platformId);

    // A sender the connector itself identifies as "me" is approved on sight:
    // the identity it established at connect outranks the pairing queue. Not
    // a row the user paused, though — approving on sight there undid the
    // pause with the next message, and deleting the bot was the only way to
    // stop it answering.
    if (!approved.has(message.userId) && isSelf) {
      const paused =
        findPairing(platformId, message.userId)?.status === "paused";
      if (!paused) {
        recordPairingRequest({
          platform: platformId,
          userId: message.userId,
          userName: message.userName,
          chatId: message.chatId,
          firstMessage: message.text,
        });
        approvePairing(platformId, message.userId);
        approved.add(message.userId);
        this.options.emitChanged();
      }
    }

    if (!approved.has(message.userId)) {
      // Recorded for the approval queue and answered with nothing: any
      // automatic reply goes out as the user's own account, to someone they
      // may not want contacted.
      recordPairingRequest({
        platform: platformId,
        userId: message.userId,
        userName: message.userName,
        chatId: message.chatId,
        firstMessage: message.text,
      });
      this.options.emitChanged();
      return;
    }

    // A bot wins over the per-sender gateway sessions: the user's own chat
    // goes to the self bot, everyone else to the bot on their row, falling
    // back to the general auto-reply bot.
    const pairedRow = findPairing(platformId, message.userId);
    const routeBot = isSelf ? selfBot : (pairedRow?.botId ?? settings.botId);
    let route: Route | null;

    if (routeBot != null && this.options.openBotChat != null) {
      // The self chat goes to the bot's forever chat, where the user can see
      // it: only the user is ever in it, so there is no sender to keep apart.
      const foreverChat = isSelf;
      route = await this.ensureBotRoute(
        platformId,
        message,
        routeBot,
        foreverChat
      );
    } else {
      const workspaceId = this.options.resolveWorkspaceId();
      if (workspaceId == null) {
        await this.safeSend(
          platformId,
          message.chatId,
          NO_WORKSPACE_NOTICE,
          message.replyContext
        );
        return;
      }
      route = await this.ensureRoute(platformId, message, workspaceId);
    }
    if (route == null) return;

    // A chat linked before WhatsApp finished syncing its chat list was named
    // by its number, and the label is fixed at route creation; once the name
    // arrives, the transcript should stop reading like a phone bill.
    const named = senderLabel(platformId, message);
    if (named !== route.senderLabel && message.userName != null)
      route.senderLabel = named;

    // Busyness belongs to the session, not the route: bot routes for
    // different chats share one session, and two prompts at once would mix
    // two turns' output into one buffer.
    const active = this.routesBySession.get(route.sessionId);

    // A stopped or crashed session never delivers its idle event here, so a
    // route stuck busy past any plausible turn length is reset.
    if (
      active != null &&
      active.busy &&
      Date.now() - active.busySince > BUSY_RESET_MS
    ) {
      console.log(
        `[messaging] ${active.platform}:${active.chatId} turn stuck busy — resetting`
      );
      active.busy = false;
      active.buffer = "";
    }

    // A second message mid-turn is queued, reply context included, rather
    // than dropped or interleaved.
    if (active != null && active.busy) {
      // A follow-up from the chat whose turn is running steers that turn;
      // other chats wait, since theirs is a different conversation.
      if (active === route) {
        this.steer(route, message.text, message.replyContext);
        return;
      }

      if (route.queue.length >= MAX_QUEUED_MESSAGES) {
        // Once per turn, or the bot becomes an echo.
        if (!route.queueFullNotified) {
          route.queueFullNotified = true;
          await this.safeSend(
            platformId,
            message.chatId,
            QUEUE_FULL_NOTICE,
            message.replyContext
          );
        }
        return;
      }

      route.queue.push({
        text: message.text,
        replyContext: message.replyContext,
      });
      return;
    }

    this.dispatch(route, message.text, message.replyContext);
  }

  /**
   * The route for a chat whose messages go to a bot. All such routes share
   * the bot's one session; each chat keeps its own route so replies return
   * to the chat whose message the turn answered.
   */
  private async ensureBotRoute(
    platformId: MessagingPlatformId,
    message: InboundMessage,
    botId: string,
    foreverChat = false
  ): Promise<Route | null> {
    const key = `${platformId}:${message.chatId}`;

    const pending = this.pendingRoutes.get(key);
    if (pending != null) return pending;

    const creating = (async (): Promise<Route | null> => {
      let handle: { workspaceId: string; sessionId: string };
      try {
        // The bot's conversation with this chat, revived if dead; the forever
        // chat only for the self chat or a build wired without sender chats.
        handle =
          this.options.openBotSenderChat != null && !foreverChat
            ? await this.options.openBotSenderChat(
                botId,
                platformId,
                message.chatId,
                message.userName ?? message.userId
              )
            : await this.options.openBotChat!(botId);
      } catch (error) {
        console.error(`[messaging] bot ${botId} unreachable:`, error);
        return null;
      }

      const existing = this.routes.get(key);
      if (existing != null && existing.sessionId === handle.sessionId)
        return existing;

      const route: Route = {
        platform: platformId,
        chatId: message.chatId,
        sessionId: handle.sessionId,
        workspaceId: handle.workspaceId,
        userId: message.userId,
        buffer: "",
        bufferMessageId: null,
        taggedReply: null,
        busy: false,
        busySince: 0,
        queue: [],
        queueFullNotified: false,
        viaBot: true,
        senderLabel: senderLabel(platformId, message),
        pendingIntro:
          "intro" in handle && typeof handle.intro === "string"
            ? handle.intro
            : null,
      };

      if (existing != null) this.routesBySession.delete(existing.sessionId);
      this.routes.set(key, route);
      // Not registered in routesBySession here: bot routes claim the session
      // at dispatch, since several of them share it.
      return route;
    })().finally(() => {
      this.pendingRoutes.delete(key);
    });
    this.pendingRoutes.set(key, creating);
    return creating;
  }

  private async ensureRoute(
    platformId: MessagingPlatformId,
    message: InboundMessage,
    workspaceId: string
  ): Promise<Route | null> {
    const key = `${platformId}:${message.chatId}`;
    const existing = this.routes.get(key);
    // Reuse only within the same workspace: if the user repointed messaging at
    // a different project, the old session is in the wrong directory.
    if (existing != null && existing.workspaceId === workspaceId)
      return existing;

    // Two messages arriving together must not each start a session: the second
    // waits on the first's creation and lands in the same route (where the
    // busy check then queues it).
    const pending = this.pendingRoutes.get(key);
    if (pending != null) return pending;

    const creating = this.createRoute(
      key,
      platformId,
      message,
      workspaceId
    ).finally(() => {
      this.pendingRoutes.delete(key);
    });
    this.pendingRoutes.set(key, creating);
    return creating;
  }

  private async createRoute(
    key: string,
    platformId: MessagingPlatformId,
    message: InboundMessage,
    workspaceId: string
  ): Promise<Route | null> {
    const existing = this.routes.get(key);

    const session = this.options.createAgentSession(workspaceId);
    const label = `${platformLabel(platformId)} · ${message.userName ?? message.userId}`;
    this.options.updateSessionLabel(workspaceId, session.id, label);

    const { autoApproveTools } = readGatewaySettings();
    const started = await this.options.startSession(
      workspaceId,
      session.id,
      // Nobody is at the keyboard to approve a tool for a remote turn; the
      // pairing allowlist is what keeps Bypass from being an open door.
      autoApproveTools ? readDefaultAgentMode() : AgentMode.AcceptEdits
    );

    if (!started.success) {
      await this.safeSend(
        platformId,
        message.chatId,
        `Could not start the agent: ${started.error ?? "unknown error"}`,
        message.replyContext
      );
      return null;
    }

    const route: Route = {
      platform: platformId,
      chatId: message.chatId,
      sessionId: session.id,
      workspaceId,
      userId: message.userId,
      buffer: "",
      bufferMessageId: null,
      taggedReply: null,
      busy: false,
      busySince: 0,
      queue: [],
      queueFullNotified: false,
      viaBot: false,
      senderLabel: "",
      pendingIntro: null,
    };

    if (existing != null) {
      this.routesBySession.delete(existing.sessionId);
    }
    this.routes.set(key, route);
    this.routesBySession.set(session.id, route);
    return route;
  }

  /**
   * Drop the routes bound to a deleted session. A route left pointing at one
   * dispatches every later message into nothing, with no reply and no error;
   * forgetting it lets the next message create a fresh session.
   */
  forgetSession(sessionId: string): void {
    this.routesBySession.delete(sessionId);
    // Every route bound to it, not just the registered one — bot routes for
    // several chats can share a session.
    for (const [key, route] of this.routes) {
      if (route.sessionId === sessionId) this.routes.delete(key);
    }
  }

  private dispatch(
    route: Route,
    text: string,
    replyContext?: Record<string, string>
  ): void {
    route.busy = true;
    route.busySince = Date.now();
    route.buffer = "";
    route.bufferMessageId = null;
    route.taggedReply = null;
    // A fresh turn may fill the queue again, and deserves to say so again.
    route.queueFullNotified = false;
    // Set at dispatch time, not arrival: the context must describe the message
    // this turn is answering, not one that queued behind it.
    route.replyContext = replyContext;
    // Bot routes share one session, so the dispatching route claims the event
    // stream for its turn. A no-op for ordinary routes.
    this.routesBySession.set(route.sessionId, route);
    // A bot answers many chats from one conversation, so the prompt says
    // which one is talking.
    const framed = route.viaBot ? `[${route.senderLabel}] ${text}` : text;
    // The rules preamble rides on the first prompt, never as a message of its
    // own, so no inbound message is seen before the rules; a one-line
    // reminder on every later turn keeps them in front of the model.
    const prompt =
      route.pendingIntro != null
        ? `${route.pendingIntro}\n\n${framed}`
        : route.viaBot
          ? `${REPLY_REMINDER}\n\n${framed}`
          : framed;
    route.pendingIntro = null;
    // Echoed at dispatch, not arrival, so a queued message lands in the
    // transcript next to the turn it started. The rules ride along to the
    // model but never into the transcript: they are the same paragraph every
    // turn, and reading them is not reading the conversation.
    this.options.emitUserMessage(route.workspaceId, route.sessionId, framed);
    this.options.sendMessage(route.workspaceId, route.sessionId, prompt);
  }

  /**
   * A message for the turn already running on this route; the host steers
   * the turn with it. The reply context moves to this message so the answer
   * threads against the latest thing they said.
   */
  private steer(
    route: Route,
    text: string,
    replyContext?: Record<string, string>
  ): void {
    // An answer the model had already finished goes now, before the new
    // message can make it write a second one. Only the last reply of a turn
    // is sent, so without this a "hey" landing behind a real question loses
    // the answer to it — and the reply that does go out says "as I said
    // above" about words nobody ever received.
    const written = lastTaggedReply(route.buffer) ?? route.taggedReply;
    if (written != null && written !== "NO_REPLY") {
      this.deliver(route, written);
      route.buffer = "";
      route.bufferMessageId = null;
      route.taggedReply = null;
    }
    route.replyContext = replyContext ?? route.replyContext;
    const prompt = route.viaBot ? `[${route.senderLabel}] ${text}` : text;
    this.options.emitUserMessage(route.workspaceId, route.sessionId, prompt);
    this.options.sendMessage(route.workspaceId, route.sessionId, prompt);
  }

  // ---------------------------------------------------------------------------
  // Agent output
  // ---------------------------------------------------------------------------

  /**
   * Tap the agent's NDJSON stream for sessions this gateway owns. Called for
   * every event on every session, so the miss case is one map lookup and out.
   */
  handleAgentEvent(sessionId: string, payload: DesktopEvent): void {
    const route = this.routesBySession.get(sessionId);
    if (route == null || payload.type !== "event") return;

    const event = payload.event;

    if (event.type === "text_delta") {
      // A new assistant message starts: what came before was not the reply.
      if (
        event.messageId != null &&
        route.bufferMessageId != null &&
        event.messageId !== route.bufferMessageId
      ) {
        route.taggedReply = lastTaggedReply(route.buffer) ?? route.taggedReply;
        route.buffer = "";
      }
      if (event.messageId != null) route.bufferMessageId = event.messageId;
      route.buffer += event.content;
      return;
    }

    // Text before a tool call is narration, not the reply, except a reply the
    // model already wrapped, which a later tool call must not throw away.
    if (event.type === "tool_call_start") {
      route.taggedReply = lastTaggedReply(route.buffer) ?? route.taggedReply;
      route.buffer = "";
      route.bufferMessageId = null;
      return;
    }

    // `turn_complete` is not the end of a user-level turn (the CLI emits one
    // per round of tool calls); the only authoritative terminators are
    // `status_changed: idle` and `error`.
    if (event.type === "error") {
      const raw =
        event.error?.message ??
        event.error?.segmentData?.message ??
        "The agent hit an error.";
      // "No model provider is configured" and pi's own /login hint, with
      // filesystem paths, went out to a phone as the bot's reply. Nothing on
      // that side can act on it; the pane and the log keep the real text.
      const detail =
        event.error?.code === "model_unavailable" ? NO_MODEL_REPLY : raw;
      if (detail !== raw)
        console.log(
          `[messaging] ${route.platform}:${route.chatId} model unavailable, replied generically: ${raw}`
        );

      // Some provider failures are reported after the turn's idle event.
      // Forwarding one would send the remote user raw provider text about a
      // turn that was already answered; the pane and the log still show it.
      if (!route.busy) {
        console.log(
          `[messaging] ${route.platform}:${route.chatId} error after the turn ended: ${detail}`
        );
        return;
      }

      // The remote user gets what the agent produced plus the error, now. The
      // route stays busy until the trailing idle so a queued message cannot
      // race a turn still winding down.
      route.buffer =
        route.buffer.length > 0 ? `${route.buffer}\n\n${detail}` : detail;
      this.flushReply(route);
      return;
    }

    if (event.type === "status_changed" && event.status === AgentStatus.Idle) {
      this.finishTurn(route);
    }
  }

  /** Send whatever the turn has produced so far and clear the buffer. */
  private flushReply(route: Route): void {
    // The last round's words win when they carry a reply; otherwise the
    // reply wrapped before a tool round is what the model meant to send.
    const reply =
      lastTaggedReply(route.buffer) == null && route.taggedReply != null
        ? route.taggedReply
        : outgoingWords(route.buffer);
    route.buffer = "";
    route.taggedReply = null;

    // The agent's way of sending nothing; the sentinel must never reach a chat.
    if (reply === "NO_REPLY") return;

    // Words addressed to the user, about to be said to their friend. The
    // preamble forbids it, but an instruction the model can forget is not a
    // guarantee against the one thing this feature must never do.
    const meta = commentaryMarker(reply);
    if (meta != null) {
      console.log(
        `[messaging] held back a reply meant for the user (${meta}) on ` +
          `${route.platform}:${route.chatId}`
      );
      // Not silence, which reads as the user ignoring them: the deferral the
      // preamble already prescribes goes instead.
      this.deliver(route, DEFERRAL);
      return;
    }

    if (reply.length > 0) {
      this.deliver(
        route,
        reply.length > MAX_REPLY_LENGTH
          ? `${reply.slice(0, MAX_REPLY_LENGTH)}\n\n[truncated]`
          : reply
      );
    }
  }

  /**
   * Send the words and show them. What the transcript shows is what left the
   * app, not what the model wrote around it: on a bot route the turn's own
   * text is withheld (see relayingSession) precisely so this stands alone.
   */
  private deliver(route: Route, text: string): void {
    const words = forChat(text, route.platform);
    void this.safeSend(route.platform, route.chatId, words, route.replyContext);
    if (!route.viaBot) return;
    this.options.emitAgentMessage?.(
      route.workspaceId,
      route.sessionId,
      `${RESPONSE_LABEL} ${words}`
    );
  }

  /**
   * Is this session mid-turn on a bot route? Such a turn's text is thinking
   * wrapped around a <reply> tag, addressed to nobody: the transcript shows
   * the delivered words instead. False between turns, so the user talking to
   * the bot in its own chat still sees ordinary answers.
   */
  relayingSession(sessionId: string): boolean {
    const route = this.routesBySession.get(sessionId);
    return route != null && route.viaBot && route.busy;
  }

  /** Flush the buffered reply, free the route, start the next queued turn. */
  private finishTurn(route: Route): void {
    if (!route.busy) return;

    this.flushReply(route);
    route.busy = false;

    const next = route.queue.shift();
    if (next != null) {
      this.dispatch(route, next.text, next.replyContext);
      return;
    }

    // Bot routes share the session: another chat may have queued while this
    // one held the turn, and nothing else will ever start it.
    if (route.viaBot) {
      for (const sibling of this.routes.values()) {
        if (sibling.sessionId !== route.sessionId || sibling === route)
          continue;
        const queued = sibling.queue.shift();
        if (queued != null) {
          this.dispatch(sibling, queued.text, queued.replyContext);
          return;
        }
      }
    }
  }

  /**
   * Send without letting a delivery failure take down the caller: the turn
   * already happened, and a throw here would land in an event handler as an
   * unhandled rejection.
   */
  private async safeSend(
    platformId: MessagingPlatformId,
    chatId: string,
    text: string,
    replyContext?: Record<string, string>
  ): Promise<void> {
    // Retried, then recorded, never dropped. The waits let a connector
    // mid-restart come back; a failure that survives all three goes into the
    // message log so read_chat_messages and the traffic view tell the truth.
    const delays = [0, 15_000, 60_000];
    let lastError: unknown = null;
    for (const wait of delays) {
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const connector = this.connectors.get(platformId);
      if (connector == null) {
        lastError = new Error("the connector is not running");
        continue;
      }
      try {
        await connector.sendText(chatId, text, replyContext);
        // Recorded like a failure is, so "did the bot answer?" has an answer
        // on disk.
        this.appendLog({
          platform: platformId,
          chatId,
          userId: "me",
          userName: null,
          text,
          direction: "out",
          at: new Date().toISOString(),
        });
        return;
      } catch (error) {
        lastError = error;
        console.error(
          `[messaging] ${platformId} send failed (will retry):`,
          error
        );
      }
    }
    console.error(
      `[messaging] ${platformId} send to ${chatId} failed after ${delays.length} attempts — giving up`
    );
    this.appendLog({
      platform: platformId,
      chatId,
      userId: "me",
      userName: null,
      text: `[NOT DELIVERED] ${text}\n(delivery failed: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      })`,
      direction: "out",
      at: new Date().toISOString(),
    });
  }

  // ---------------------------------------------------------------------------
  // IPC surface
  // ---------------------------------------------------------------------------

  /** Shared-bot platforms: mint a pairing code. See AbacusChannelsConnector. */
  async pairSharedChannel(
    platformId: MessagingPlatformId
  ): Promise<MessagingSnapshot> {
    const connector = this.connectors.get(platformId);
    if (connector instanceof AbacusChannelsConnector) {
      await connector.pair();
      this.options.emitChanged();
    }
    return this.getSnapshot();
  }

  /** Shared-bot platforms: open the install link in an app-owned window. */
  async openSharedChannelLink(
    platformId: MessagingPlatformId,
    target: "install" | "dm" = "install"
  ): Promise<void> {
    const connector = this.connectors.get(platformId);
    if (connector instanceof AbacusChannelsConnector)
      connector.openLink(target);
  }

  async unlinkSharedChannel(
    platformId: MessagingPlatformId
  ): Promise<MessagingSnapshot> {
    const connector = this.connectors.get(platformId);
    if (connector instanceof AbacusChannelsConnector) {
      await connector.unlink();
      this.options.emitChanged();
    }
    return this.getSnapshot();
  }

  /** Bring a web-login platform's sign-in window back to the front. */
  showMessagingLogin(platformId: MessagingPlatformId): void {
    const connector = this.connectors.get(platformId);
    if (
      connector instanceof TelegramWebConnector ||
      connector instanceof DiscordWebConnector ||
      connector instanceof WhatsAppWebConnector
    )
      connector.showLoginWindow();
  }

  // ---------------------------------------------------------------------------
  // Agent-initiated messaging (the send_chat_message / list_chats tools)
  // ---------------------------------------------------------------------------

  /** Platforms with a live connector: what the agent could send through now. */
  runningPlatforms(): MessagingPlatformId[] {
    return [...this.connectors.keys()];
  }

  /**
   * Everyone the agent can address by name: the pairing store, overlaid with
   * the platform's address book where there is one. The address-book name
   * wins, because "Mom" is what the user will actually say.
   */
  private allKnownChats(platformId?: MessagingPlatformId): Array<{
    platform: MessagingPlatformId;
    chatId: string;
    name: string;
    status: "pending" | "approved" | "paused";
    isGroup?: boolean;
  }> {
    const byKey = new Map<
      string,
      {
        platform: MessagingPlatformId;
        chatId: string;
        name: string;
        status: "pending" | "approved" | "paused";
        isGroup?: boolean;
      }
    >();

    for (const row of listPairing()) {
      byKey.set(`${row.platform}:${row.chatId}`, {
        platform: row.platform,
        chatId: row.chatId,
        name: row.userName ?? row.userId,
        status: row.status,
      });
    }

    for (const [id, connector] of this.connectors) {
      for (const contact of connector.listContacts?.() ?? []) {
        byKey.set(`${id}:${contact.chatId}`, {
          platform: id,
          chatId: contact.chatId,
          name: contact.name,
          status: "approved",
          isGroup: contact.isGroup,
        });
      }
    }

    const rows = [...byKey.values()];
    return platformId == null
      ? rows
      : rows.filter((row) => row.platform === platformId);
  }

  /**
   * The platform's chats with messages waiting, fresh from the platform. Null
   * when the platform cannot answer at all; throws when it can but not right
   * now (not linked, bridge detached).
   */
  async unreadChats(platformId: MessagingPlatformId): Promise<Array<{
    chatId: string;
    name: string;
    unreadCount: number;
  }> | null> {
    const connector = this.connectors.get(platformId);
    if (connector?.unreadChats == null) return null;
    return await connector.unreadChats();
  }

  /**
   * The chat id that means "me" on each running platform. The agent has no
   * other way to know it: it is in no address book.
   */
  selfChats(): Array<{ platform: MessagingPlatformId; chatId: string }> {
    const rows: Array<{ platform: MessagingPlatformId; chatId: string }> = [];
    for (const [platformId, connector] of this.connectors) {
      const chatId = connector.selfChatId?.() ?? null;
      if (chatId != null && chatId.length > 0)
        rows.push({ platform: platformId, chatId });
    }
    return rows;
  }

  /**
   * Platforms that are actually up, as opposed to merely started.
   * `runningPlatforms` says whether a tool exists; this says whether it will
   * work. An unlinked phone leaves the connector in place, waiting on a QR.
   */
  livePlatforms(): MessagingPlatformId[] {
    return [...this.connectors.keys()].filter(
      (id) => this.states.get(id)?.state === "connected"
    );
  }

  /**
   * `livePlatforms`, after each platform that can re-checks its login now:
   * the cached state is a poll behind. A probe that hangs gets a moment and
   * then the cached state stands, since a send must not wait on it.
   */
  async probeLivePlatforms(): Promise<MessagingPlatformId[]> {
    await Promise.all(
      [...this.connectors.values()].map((connector) =>
        connector.probeLive == null
          ? Promise.resolve()
          : Promise.race([
              connector.probeLive().then(
                () => undefined,
                () => undefined
              ),
              new Promise<void>((resolve) =>
                setTimeout(resolve, PROBE_LIVE_TIMEOUT_MS)
              ),
            ])
      )
    );
    return this.livePlatforms();
  }

  // ---------------------------------------------------------------------------
  // Auto-reply (the bot-only auto_reply tool)
  // ---------------------------------------------------------------------------

  /**
   * The first time a platform proves which chat is the user's own, mint a
   * dedicated self bot for it. Once ever: the stored flag survives relinks,
   * so a user who deleted the bot is left be. The global switch and general
   * bot stay untouched: that switch answers every chat on every platform as
   * the user, and the bootstrap's promise is only the self chat.
   */
  private maybeBootstrapSelfLane(platform: SelfLanePlatform): void {
    const settings = readGatewaySettings();
    if ((settings.autoReplyBootstrappedFor ?? []).includes(platform)) return;
    const botId = this.options.createAutoReplyBot?.(platform) ?? null;
    saveGatewaySettings({
      autoReplyBootstrappedFor: [platform],
      selfBotIds: { [platform]: botId },
    });
    if (botId == null) return;
    console.log(
      `[messaging] ${platform} linked — auto-reply bot ready in the self chat`
    );
    this.options.emitChanged();
  }

  /** The two settings-pane switches, reachable from inside a bot's chat. */
  enableAutoReply(botId: string): void {
    saveGatewaySettings({ respondToInbound: true, botId });
    this.options.emitChanged();
  }

  /** Stop answering. The pairing list survives — stopping is not forgetting. */
  disableAutoReply(): void {
    saveGatewaySettings({ respondToInbound: false });
    this.options.emitChanged();
  }

  autoReplyStatus(): {
    respondToInbound: boolean;
    botId: string | null;
    approved: Array<{
      platform: MessagingPlatformId;
      userId: string;
      name: string;
    }>;
    /** Senders who have messaged in but are not allowed — newest last. */
    pending: Array<{
      platform: MessagingPlatformId;
      userId: string;
      name: string;
    }>;
  } {
    const settings = readGatewaySettings();
    const rows = (status: "approved" | "pending") =>
      listPairing()
        .filter((row) => row.status === status)
        .map((row) => ({
          platform: row.platform,
          userId: row.userId,
          name: row.userName ?? row.userId,
        }));
    return {
      respondToInbound: settings.respondToInbound,
      botId: settings.botId,
      approved: rows("approved"),
      pending: rows("pending"),
    };
  }

  /**
   * Everyone a sender name could resolve against. The pairing store comes
   * last so its userId, the one a real inbound message carried, wins the
   * resolver's dedupe for a person who appears in both.
   */
  senderCandidates(platformId?: MessagingPlatformId): SenderCandidate[] {
    const rows: SenderCandidate[] = [];
    for (const [id, connector] of this.connectors) {
      if (platformId != null && id !== platformId) continue;
      for (const contact of connector.listContacts?.() ?? [])
        rows.push({
          platform: id,
          // An address-book entry has never messaged in; on every platform
          // here a DM's chat id is the peer's own id.
          userId: contact.chatId,
          chatId: contact.chatId,
          name: contact.name,
        });
    }
    for (const row of listPairing()) {
      if (platformId != null && row.platform !== platformId) continue;
      rows.push({
        platform: row.platform,
        userId: row.userId,
        chatId: row.chatId,
        name: row.userName ?? row.userId,
      });
    }
    return rows;
  }

  /**
   * Approve a sender without the pairing queue: the user naming them in chat
   * is the approval the queue exists to collect.
   */
  allowSender(candidate: SenderCandidate, botId?: string): void {
    recordPairingRequest({
      platform: candidate.platform,
      userId: candidate.userId,
      userName: candidate.name,
      chatId: candidate.chatId,
      firstMessage: null,
    });
    approvePairing(candidate.platform, candidate.userId, {
      managedBy: "bot",
      ...(botId != null ? { botId } : {}),
    });
    // A bot taking a sender over takes the standing route with it: the next
    // message must not ride the previous bot's conversation.
    this.dropRoutes(candidate.platform, candidate.userId, candidate.chatId);
    this.options.emitChanged();
  }

  removeSender(candidate: SenderCandidate): void {
    this.forgetSender(candidate.platform, candidate.userId, candidate.chatId);
    this.options.emitChanged();
  }

  /** The row, its live routes, and every bot conversation with the sender. */
  private forgetSender(
    platformId: MessagingPlatformId,
    userId: string,
    chatId: string | null
  ): void {
    revokePairing(platformId, userId);
    this.dropRoutes(platformId, userId, chatId);
    this.options.forgetSenderChats?.(platformId, chatId ?? userId);
  }

  private dropRoutes(
    platformId: MessagingPlatformId,
    userId: string,
    chatId: string | null
  ): void {
    for (const [key, route] of this.routes) {
      if (route.platform !== platformId) continue;
      if (route.userId !== userId && route.chatId !== chatId) continue;
      this.routes.delete(key);
      this.routesBySession.delete(route.sessionId);
    }
  }

  /**
   * Every one-to-one chat known on a platform, uncapped and without the
   * user's own chat: the invite picker shows the whole address book.
   */
  listInviteContacts(
    platformId: MessagingPlatformId
  ): Array<{ chatId: string; name: string }> {
    const self = this.connectors.get(platformId)?.selfChatId?.() ?? null;
    return this.allKnownChats(platformId)
      .filter((row) => row.isGroup !== true && row.chatId !== self)
      .map(({ chatId, name }) => ({ chatId, name }));
  }

  listKnownChats(
    query?: string,
    platformId?: MessagingPlatformId
  ): Array<{
    platform: MessagingPlatformId;
    chatId: string;
    name: string;
    status: "pending" | "approved" | "paused";
  }> {
    return this.listKnownChatsDetailed(query, platformId).rows;
  }

  /**
   * The chat list, capped per platform, saying what the cap hid: a flat cap
   * lets one address book hide another platform's few DMs, and the hidden
   * count tells the model to scope by platform rather than conclude absence.
   */
  listKnownChatsDetailed(
    query?: string,
    platformId?: MessagingPlatformId
  ): {
    rows: Array<{
      platform: MessagingPlatformId;
      chatId: string;
      name: string;
      status: "pending" | "approved" | "paused";
    }>;
    hidden: Partial<Record<MessagingPlatformId, number>>;
  } {
    const needle = query?.trim().toLowerCase() ?? "";
    const matching = this.allKnownChats(platformId).filter(
      (row) => needle.length === 0 || row.name.toLowerCase().includes(needle)
    );
    // The same rule a send resolves by: an exact name match means that
    // contact, and nothing else is in the running.
    const exact =
      needle.length > 0
        ? matching.filter((row) => row.name.toLowerCase() === needle)
        : [];
    const all = exact.length > 0 ? exact : matching;
    if (all.length <= CHAT_LIST_CAP) return { rows: all, hidden: {} };

    // Over the cap: each platform gets a share, never below the floor, and
    // leftover room goes round-robin to whoever still has rows.
    const groups = new Map<MessagingPlatformId, typeof all>();
    for (const row of all) {
      const list = groups.get(row.platform) ?? [];
      list.push(row);
      groups.set(row.platform, list);
    }
    const share = Math.max(
      CHAT_LIST_PLATFORM_FLOOR,
      Math.floor(CHAT_LIST_CAP / groups.size)
    );
    const taken = new Map<MessagingPlatformId, number>();
    let total = 0;
    for (const [platform, list] of groups) {
      const n = Math.min(share, list.length, CHAT_LIST_CAP - total);
      taken.set(platform, n);
      total += n;
    }
    let progressed = true;
    while (total < CHAT_LIST_CAP && progressed) {
      progressed = false;
      for (const [platform, list] of groups) {
        if (total >= CHAT_LIST_CAP) break;
        const n = taken.get(platform) ?? 0;
        if (n >= list.length) continue;
        taken.set(platform, n + 1);
        total += 1;
        progressed = true;
      }
    }
    const rows: typeof all = [];
    const hidden: Partial<Record<MessagingPlatformId, number>> = {};
    for (const [platform, list] of groups) {
      const n = taken.get(platform) ?? 0;
      rows.push(...list.slice(0, n));
      if (list.length > n) hidden[platform] = list.length - n;
    }
    return { rows, hidden };
  }

  /**
   * Turn whatever the user called the recipient into a deliverable id. Ids
   * pass through; a name resolves exact match first, then unique substring.
   * Several hits is an error: "hi Mom" to the wrong Mo is worse than asking.
   */
  private resolveTarget(platformId: MessagingPlatformId, to: string): string {
    const target = to.trim();

    // "me" is a name no address book holds, and the one the user says most.
    if (/^(me|myself|self)$/i.test(target)) {
      const self = this.connectors.get(platformId)?.selfChatId?.() ?? null;
      if (self != null && self.length > 0) return self;
      throw new Error(
        `${platformLabel(platformId)} has not said which account it is connected as yet. ` +
          "Wait for it to finish connecting, or give a phone number."
      );
    }

    if (target.includes("@")) return target;
    const digits = target.replace(/[\s\-().]/g, "");
    if (/^\+?\d{4,}$/.test(digits)) return target;

    const candidates = this.allKnownChats(platformId);
    // A known chat id that happens not to look like one — Slack's C… channel
    // ids, say — is an id, not a name to resolve.
    if (candidates.some((row) => row.chatId === target)) return target;

    const needle = target.toLowerCase();
    const exact = candidates.filter((row) => row.name.toLowerCase() === needle);
    const matches =
      exact.length > 0
        ? exact
        : candidates.filter((row) => row.name.toLowerCase().includes(needle));

    if (matches.length === 1) return matches[0]!.chatId;
    if (matches.length === 0) {
      // The connector is the arbiter, not this list, which is only the
      // rendered sidebar window (archived chats never render). Every
      // connector fails honestly on a genuine miss.
      return target;
    }
    const listed = matches
      .slice(0, 5)
      .map((row) => `${row.name} (${row.chatId})`)
      .join(", ");
    throw new Error(
      `"${target}" matches more than one contact on ${platformLabel(platformId)}: ${listed}. ` +
        "Ask the user which one, then send to that chat id."
    );
  }

  /**
   * Send on the agent's behalf. Unlike safeSend, a failed delivery must reach
   * the model as an error it can report. No allowlist: the user asking
   * "message so-and-so" from a chat they are driving is the authorization.
   */
  async sendToChat(
    platformId: MessagingPlatformId,
    chatId: string,
    text: string
  ): Promise<void> {
    // "me" on a platform with no self chat (Discord: you cannot DM yourself)
    // is still deliverable through the shared Abacus bot's DM.
    if (/^(me|myself|self)$/i.test(chatId.trim())) {
      const own = this.connectors.get(platformId)?.selfChatId?.() ?? null;
      const sharedId = SHARED_BOT_PLATFORM_OF[platformId];
      const shared =
        sharedId != null ? this.connectors.get(sharedId) : undefined;
      if ((own == null || own.length === 0) && shared?.selfChatId?.() != null)
        platformId = sharedId as MessagingPlatformId;
    }
    const connector = this.connectors.get(platformId);
    if (connector == null) {
      throw new Error(
        `${platformLabel(platformId)} is not connected. Connect it from Settings → Connectors first.`
      );
    }

    // A send during startup waits rather than failing on "who is me".
    await this.awaitReady(platformId);
    const target = this.resolveTarget(platformId, chatId);
    text = forChat(text, platformId);
    await connector.sendText(target, text);
    this.appendLog({
      platform: platformId,
      chatId: target,
      userId: "me",
      userName: null,
      text,
      direction: "out",
      at: new Date().toISOString(),
    });
  }

  /** Send a file where sendToChat would send words. Platform support varies. */
  async sendFileToChat(
    platformId: MessagingPlatformId,
    chatId: string,
    filePath: string,
    caption?: string
  ): Promise<void> {
    const connector = this.connectors.get(platformId);
    if (connector == null) {
      throw new Error(
        `${platformLabel(platformId)} is not connected. Connect it from Settings → Connectors first.`
      );
    }
    if (connector.sendFile == null) {
      throw new Error(
        `${platformLabel(platformId)} cannot send files yet. Send a text, or use a platform that can.`
      );
    }

    await this.awaitReady(platformId);
    const target = this.resolveTarget(platformId, chatId);
    await connector.sendFile(target, filePath, caption);
    this.appendLog({
      platform: platformId,
      chatId: target,
      userId: "me",
      userName: null,
      text: `[sent file: ${filePath}]${caption != null && caption.length > 0 ? ` ${caption}` : ""}`,
      direction: "out",
      at: new Date().toISOString(),
    });
  }

  /** Recent traffic for the read_chat_messages tool, oldest first. */
  async readMessages(filter?: {
    platform?: MessagingPlatformId;
    chatId?: string;
    limit?: number;
    query?: string;
  }): Promise<ChatLogEntry[]> {
    const limit = filter?.limit != null && filter.limit > 0 ? filter.limit : 50;

    // A content query names no chat, so it cannot go through the other
    // filters. Platforms with a live search answer from their full history;
    // the stored log covers the rest.
    const query = filter?.query?.trim() ?? "";
    if (query.length > 0) {
      const needle = query.toLowerCase();
      const hits: ChatLogEntry[] = [];
      const platforms =
        filter?.platform != null
          ? [filter.platform]
          : [...this.connectors.keys()];
      for (const platformId of platforms) {
        const connector = this.connectors.get(platformId);
        if (connector?.searchMessages == null) continue;
        try {
          // A chat id scopes the search where the platform's search is
          // per-chat; global searches ignore it.
          const found = await connector.searchMessages(
            query,
            limit,
            filter?.chatId
          );
          hits.push(
            ...found.map((row) => ({
              platform: platformId,
              chatId: row.chatId,
              userId: row.chatId,
              userName: row.name,
              text: row.snippet,
              direction: "in" as const,
              at: row.when,
            }))
          );
        } catch (error) {
          console.error(`[messaging] ${platformId} search failed:`, error);
        }
      }
      const seen = new Set(hits.map((row) => `${row.chatId}\n${row.text}`));
      for (const entry of this.messageLog) {
        if (filter?.platform != null && entry.platform !== filter.platform)
          continue;
        if (!entry.text.toLowerCase().includes(needle)) continue;
        if (seen.has(`${entry.chatId}\n${entry.text}`)) continue;
        hits.push(entry);
      }
      return hits.slice(0, limit);
    }

    // One chat on a connector that can open it live: the real history, not
    // the passive log. The platform is often left off the call, so every live
    // reader gets a try; a wrong-platform id yields nothing and falls through.
    let unreachable: unknown = null;
    if (filter?.chatId != null) {
      const platforms =
        filter.platform != null
          ? [filter.platform]
          : [...this.connectors.keys()];
      for (const platformId of platforms) {
        const connector = this.connectors.get(platformId);
        if (connector?.readChat == null) continue;
        try {
          const live = await connector.readChat(filter.chatId, limit);
          if (live.length === 0) continue;
          return live.map((row) => ({
            platform: platformId,
            chatId: filter.chatId!,
            userId: filter.chatId!,
            userName: row.userName,
            text: row.text,
            direction: row.direction,
            at: row.at,
          }));
        } catch (error) {
          console.error(`[messaging] ${platformId} live read failed:`, error);
          // Kept: with nothing in the log either, a chat the connector could
          // not reach must not read as a chat with nothing in it. The next
          // connector still gets its turn, and the log still wins.
          unreachable ??= error;
        }
      }
    }

    const rows = this.messageLog.filter(
      (entry) =>
        (filter?.platform == null || entry.platform === filter.platform) &&
        (filter?.chatId == null || entry.chatId === filter.chatId)
    );
    if (rows.length === 0 && unreachable != null) throw unreachable;
    return rows.slice(-limit);
  }

  /**
   * Platforms up but not yet ready to be asked about: still linking, or not
   * yet sure who the account is. A bot's first mission fires seconds after
   * launch, and "no contacts" in that window is true and wrong.
   */
  startingPlatforms(): MessagingPlatformId[] {
    return [...this.connectors.entries()]
      .filter(([id, connector]) => {
        const state = this.states.get(id)?.state;
        if (state === "connecting") return true;
        if (state !== "connected") return false;
        // Connected but the chat list not yet read: the rail is still
        // rendering, and its first read can come back empty.
        if (connector.contactsReady != null && !connector.contactsReady())
          return true;
        // Connected but self unknown: the address book is being read.
        if (connector.selfChatId == null) return false;
        const self = connector.selfChatId();
        return self == null || self.length === 0;
      })
      .map(([id]) => id);
  }

  /**
   * Wait, boundedly, for a platform to finish starting. Resolves either way,
   * so a platform that never comes up costs one wait, not a hang.
   */
  async awaitReady(
    platformId?: MessagingPlatformId,
    timeoutMs = READY_WAIT_MS
  ): Promise<void> {
    const pending = (): boolean => {
      const starting = this.startingPlatforms();
      return platformId == null
        ? starting.length > 0
        : starting.includes(platformId);
    };
    const deadline = Date.now() + timeoutMs;
    while (pending() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
  }

  /**
   * Re-announce the snapshot when a syncing platform finishes: nothing else
   * fires when the connector quietly learns who the account is, and the card
   * would wear "Syncing" until something unrelated changed.
   */
  private readonly syncWatchers = new Map<
    MessagingPlatformId,
    NodeJS.Timeout
  >();

  private watchSync(
    platformId: MessagingPlatformId,
    state: MessagingPlatformState
  ): void {
    const existing = this.syncWatchers.get(platformId);
    if (existing != null) {
      clearInterval(existing);
      this.syncWatchers.delete(platformId);
    }
    if (state !== "connected") return;
    if (!this.startingPlatforms().includes(platformId)) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const done = !this.startingPlatforms().includes(platformId);
      const gaveUp = Date.now() - startedAt > SYNC_WATCH_MAX_MS;
      if (!done && !gaveUp) return;
      clearInterval(timer);
      this.syncWatchers.delete(platformId);
      this.options.emitChanged();
    }, SYNC_WATCH_POLL_MS);
    this.syncWatchers.set(platformId, timer);
  }

  private isSharedBotChat(
    platformId: MessagingPlatformId,
    userName: string | null
  ): boolean {
    const sharedId = SHARED_BOT_PLATFORM_OF[platformId];
    const shared = sharedId != null ? this.connectors.get(sharedId) : undefined;
    const name =
      shared instanceof AbacusChannelsConnector ? shared.sharedBotName() : null;
    return name != null && userName != null && userName.trim() === name;
  }

  private sharedLink(
    platformId: MessagingPlatformId
  ): SharedChannelLink | undefined {
    const connector = this.connectors.get(platformId);
    return connector instanceof AbacusChannelsConnector
      ? connector.sharedLink()
      : undefined;
  }

  private appendLog(entry: ChatLogEntry): void {
    this.messageLog.push(entry);
    if (this.messageLog.length > MESSAGE_LOG_LIMIT)
      this.messageLog.splice(0, this.messageLog.length - MESSAGE_LOG_LIMIT);
    if (this.logSaveTimer != null) return;
    this.logSaveTimer = setTimeout(() => {
      this.logSaveTimer = null;
      this.saveLog();
    }, MESSAGE_LOG_SAVE_DELAY_MS);
  }

  private saveLog(): void {
    try {
      writeStoredMessageLog(this.messageLog);
    } catch (error) {
      console.error("[messaging] could not persist the message log:", error);
    }
  }

  getSnapshot(): MessagingSnapshot {
    const settings = readGatewaySettings();
    const pairing = listPairing();

    const platforms: MessagingPlatformInfo[] = MESSAGING_PLATFORM_CATALOG.map(
      (entry) => {
        const enabled = isPlatformEnabled(entry.id);
        const configured = isPlatformConfigured(entry.id);
        const live = this.states.get(entry.id);

        return {
          id: entry.id,
          nameKey: entry.nameKey,
          docsUrl: entry.docsUrl,
          enabled,
          configured,
          // The pane wears "syncing" for the stretch where a green badge
          // would be wrong; the gateway's own state stays connected, since
          // the web lane genuinely works.
          state: ((): MessagingPlatformState => {
            const resolved = resolveState({
              enabled,
              configured,
              gatewayEnabled: settings.gatewayEnabled,
              running: this.connectors.has(entry.id),
              live: live?.state ?? null,
            });
            if (resolved !== "connected") return resolved;
            if (this.startingPlatforms().includes(entry.id)) return "syncing";
            return resolved;
          })(),
          // Only while the platform is actually trying, or a disabled one
          // keeps a red error box about a connection nothing attempts.
          errorMessage:
            enabled && configured && settings.gatewayEnabled
              ? (live?.error ?? null)
              : null,
          fields: entry.fields.map((field) => {
            const value = readFieldValue(entry.id, field.key);
            return {
              ...field,
              isSet: value != null,
              redactedValue:
                value != null && field.secret ? redactSecret(value) : value,
              fromEnv: isFieldFromEnv(field.key),
            };
          }),
          pendingCount: pairing.filter(
            (row) => row.platform === entry.id && row.status === "pending"
          ).length,
          sharedLink: this.sharedLink(entry.id),
        };
      }
    );

    return {
      platforms,
      pending: pairing.filter((row) => row.status === "pending"),
      // Bot-managed rows are shown and undone under their bot in the Bots
      // pane; listing them here too gives the same grant two homes.
      approved: pairing.filter(
        (row) => row.status === "approved" && row.managedBy !== "bot"
      ),
      // The standing auto-replies, paused ones included, for the Routines pane.
      autoReplies: pairing.filter(
        (row) =>
          row.managedBy === "bot" &&
          (row.status === "approved" || row.status === "paused")
      ),
      gatewayEnabled: settings.gatewayEnabled,
      autoApproveTools: settings.autoApproveTools,
      respondToInbound: settings.respondToInbound,
      workspaceId: settings.workspaceId,
      botId: settings.botId,
    };
  }

  async updatePlatform(request: {
    platformId: MessagingPlatformId;
    enabled?: boolean;
    values?: Record<string, string>;
  }): Promise<MessagingSnapshot> {
    if (messagingPlatformSpec(request.platformId) == null)
      return this.getSnapshot();

    if (request.values != null)
      savePlatformValues(request.platformId, request.values);
    if (request.enabled != null)
      setPlatformEnabled(request.platformId, request.enabled);

    // Credentials changed under a live connector: restart it. `pending_restart`
    // covers the window where stored and in-use values disagree.
    if (request.values != null && this.connectors.has(request.platformId)) {
      await this.stopPlatform(request.platformId);
    }

    await this.syncConnectors();
    return this.getSnapshot();
  }

  async decidePairing(request: {
    platformId: MessagingPlatformId;
    userId: string;
    decision: "approve" | "revoke" | "pause" | "resume";
  }): Promise<MessagingSnapshot> {
    const row = findPairing(request.platformId, request.userId);

    if (request.decision === "pause") {
      pausePairing(request.platformId, request.userId);
      this.options.emitChanged();
      return this.getSnapshot();
    }
    if (request.decision === "approve" || request.decision === "resume") {
      // No "you're approved" message: it would go out under the user's
      // identity without them writing it. Their next message gets an answer.
      approvePairing(request.platformId, request.userId);
    } else {
      // The row, every live route this user holds, and the bot conversations
      // with them, so a re-approved user starts fresh.
      this.forgetSender(
        request.platformId,
        request.userId,
        row?.chatId ?? null
      );
    }

    this.options.emitChanged();
    return this.getSnapshot();
  }

  async updateSettings(patch: {
    gatewayEnabled?: boolean;
    autoApproveTools?: boolean;
    respondToInbound?: boolean;
    workspaceId?: string | null;
    botId?: string | null;
  }): Promise<MessagingSnapshot> {
    saveGatewaySettings(patch);
    // Repointing delivery invalidates the standing routes; the next message
    // re-resolves against the new target.
    if (patch.botId !== undefined) {
      this.routes.clear();
      this.routesBySession.clear();
    }
    await this.syncConnectors();
    return this.getSnapshot();
  }
}

/**
 * Collapse "what the user configured" and "what the connector is doing" into
 * the single state the pane renders. Configuration wins: a disabled platform
 * reads `disabled` even if a connector is briefly still winding down.
 */
const resolveState = (input: {
  enabled: boolean;
  configured: boolean;
  gatewayEnabled: boolean;
  running: boolean;
  live: MessagingPlatformState | null;
}): MessagingPlatformState => {
  if (!input.gatewayEnabled || !input.enabled) return "disabled";
  if (!input.configured) return "not_configured";
  if (
    input.live === "connected" ||
    input.live === "error" ||
    input.live === "needs_login" ||
    input.live === "rate_limited"
  )
    return input.live;
  return input.running ? "connecting" : "pending_restart";
};

/** Who the bot is talking to, as the prompt and the transcript say it. */
const senderLabel = (
  platformId: MessagingPlatformId,
  message: Pick<InboundMessage, "userName" | "userId">
): string =>
  `${platformLabel(platformId)} message from ${
    message.userName ?? message.userId
  }`;

const platformLabel = (platformId: MessagingPlatformId): string =>
  platformId === "abacus_discord"
    ? "Discord (Abacus AI bot)"
    : platformId === "abacus_telegram"
      ? "Telegram (Abacus AI bot)"
      : // Capitalising the id gives "Whatsapp"; the name has a capital A.
        platformId === "whatsapp"
        ? "WhatsApp"
        : platformId.charAt(0).toUpperCase() + platformId.slice(1);

/**
 * What counts as a loop: more than this many inbound turns from one chat
 * inside the window. Well clear of human pace: a loop has no ceiling and
 * passes any threshold within minutes, while an early one silences a group.
 */
const LOOP_BURST = 20;
const LOOP_WINDOW_MS = 60_000;
/**
 * The self chat's slower breaker, for a bot-to-bot loop that runs at a couple
 * of messages a minute. Set at eight in five minutes on the theory that
 * nobody types to themselves that often; but the self chat is where the user
 * talks to their assistant, and a real back-and-forth passes eight inside the
 * first minute. It now sits above a fast human conversation and below a loop,
 * which has no ceiling and trips the per-minute cap in seconds anyway.
 */
const SELF_LOOP_BURST = 40;
const SELF_LOOP_WINDOW_MS = 5 * 60_000;

/** How long the breaker holds before the lane answers again on its own. */
const LOOP_PAUSE_MS = 10 * 60_000;

const QUEUE_FULL_NOTICE =
  "I'm still working through what you've already sent, so that last one didn't get queued. Send it again once I've replied.";

const NO_WORKSPACE_NOTICE =
  "No workspace is set for messaging yet. Pick one in AbacusAIBot under Settings → Connectors (messaging settings), then try again.";
