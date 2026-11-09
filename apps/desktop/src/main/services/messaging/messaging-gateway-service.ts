import { randomUUID } from "node:crypto";

import { modelPath } from "@abacus-ai/agent/model-path";
import { toolActivity } from "@abacus-ai/agent/tool-display";
import { readUserLanguage } from "@abacus-ai/agent/user-language";
import { appNoteTag, frameChannelMessage } from "@abacus-ai/agent/user-text";
import type { UserTextTags } from "@abacus-ai/contract/agent-types";
import { AgentMode, AgentStatus } from "@abacus-ai/contract/agent-types";
import type { DesktopEvent } from "@abacus-ai/contract/agent-types";
import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import { isSuggestTasksTool } from "@abacus-ai/contract/bots/suggested-tasks";
import type {
  AgentSessionListItem,
  StartAgentSessionResult,
} from "@abacus-ai/contract/contracts";
import type { CreditThresholdMark } from "@abacus-ai/contract/credit-thresholds";
import {
  MESSAGING_PLATFORM_CATALOG,
  SHARED_BOT_PLATFORM_OF,
  appOfSelfLane,
  isMessagingPlatformId,
  isOwnChatTarget,
  isSelfName,
  messagingPlatformSpec,
  selfLaneOf,
  redactSecret,
  type MessagingPairedUser,
  type MessagingPlatformId,
  type MessagingPlatformInfo,
  type MessagingPlatformState,
  type MessagingSnapshot,
  type SelfLanePlatform,
  type SharedChannelLink,
  type SharedLinkTarget,
} from "@abacus-ai/contract/messaging";
import {
  outgoingWords,
  lastTaggedReply,
} from "@abacus-ai/contract/reply-envelope";

import type { HostPlatform } from "../../platform/capabilities";
import { readDefaultAgentMode } from "../config/settings";
import { reportFunnelStep } from "../debug-sync/funnel-beacon";
import { cachedAbacusAccount, onFreePlan } from "../providers/abacus";
import {
  botUpgradePage,
  fetchBillingPlan,
  fetchUpgradeUrl,
} from "../providers/abacus-upgrade";
import { environmentNoticeService } from "../providers/environment-notice-service";
import type { TurnChannel, TurnRecord } from "../session/turn-ledger";
import {
  AbacusChannelsConnector,
  SELF_CHAT_ID,
} from "./abacus-channels-connector";
import {
  channelLocale,
  type ChannelWords,
  channelWords,
} from "./channel-words";
import {
  ABACUS_BUY_CREDITS_URL,
  chatLineForCreditThreshold,
  chatLineForRoutinesOnHold,
  chatLineForSuccessPitch,
  chatFailureOf,
  chatReplyForFailure,
  chatLineForBackgroundJob,
  chatLineForMove,
  contactFailureNotice,
  FailureReplyThrottle,
  failureKind,
  wantsUpgradeUrl,
  type AccountKind,
  type TurnFailure,
} from "./chat-failure-reply";
import { forChat } from "./chat-markdown";
import { looksLikeBotOutput, UndeliverableChatError } from "./connector";
import type { InboundMessage, MessagingConnector } from "./connector";
import { DiscordWebConnector } from "./discord-web-connector";
import {
  LANE_HINT_GAP_MS,
  LaneSupervisor,
  type LaneFailure,
} from "./lane-supervisor";
import {
  approvePairing,
  pausePairing,
  approvedUserIds,
  findPairing,
  holdPairing,
  isFieldFromEnv,
  markPairingTold,
  isPlatformConfigured,
  isPlatformEnabled,
  listPairing,
  readFieldValue,
  readGatewaySettings,
  readStoredMessageLog,
  readPlatformLinkLost,
  readStoredOutbox,
  recordPairingRequest,
  revokePairing,
  saveGatewaySettings,
  savePlatformValues,
  setPlatformEnabled,
  writeStoredMessageLog,
  writeStoredOutbox,
} from "./messaging-config-service";
import {
  ChatOutbox,
  OUTBOX_RETRY_MS,
  type OwedLine,
  type OwedMessage,
} from "./messaging-outbox";
import { diskSpaceBack, userActive, watchLaneHints } from "./page-boot-watch";
import type { SenderCandidate } from "./sender-resolution";
import { TelegramWebConnector } from "./telegram-web-connector";
import {
  forgetWhatsAppLogin,
  WhatsAppWebConnector,
} from "./whatsapp-web-connector";

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

/** Words this short that promised more are the promise and nothing else. */
const PROMISE_ONLY_CHARS = 300;

/** The one message a turn sends when the model was told to go on from `held`. */
const joinHeld = (held: string | null, reply: string): string => {
  if (held == null || reply === held) return reply;
  if (reply.length === 0) return held;
  return held.length > PROMISE_ONLY_CHARS ? `${held}\n\n${reply}` : reply;
};

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

/**
 * The words for the other person, out of everything the model wrote. Asking
 * a model not to think aloud does not work; asking it to wrap the reply in
 * <reply>…</reply> does, and is checkable: only the last such block is sent.
 * Without a block the whole text goes, minus a leading <thinking> block, because a
 * reply must never be lost to a missing tag.
 */
export { outgoingWords } from "@abacus-ai/contract/reply-envelope";

/** The one rule, restated on every auto-reply turn. See dispatch. */
export const REPLY_REMINDER =
  appNoteTag("auto-reply") +
  " Everything you write here is delivered to them as if the " +
  "user typed it. Reply with only the words to send: never notes, " +
  "questions or options meant for the user, who is not in this chat. " +
  "Put the words to send inside <reply></reply>. ONLY what is inside that " +
  "tag is delivered; think, plan or note anything outside it. Nothing runs " +
  "after your reply, so anything that needs looking up (weather, a " +
  "search, a date), do it now with your tools and answer with the result; " +
  'never send "hold on" or "let me check".';

/**
 * How many messages may wait behind a running turn. Every queued message
 * becomes a billed agent turn, so an unbounded queue is a spending leak. Past
 * the cap the sender is told once rather than silently dropped.
 */
const MAX_QUEUED_MESSAGES = 20;

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

/**
 * How long a login may still land after its connect dialog closed unlinked.
 * The phone is ahead of the app (people close on the phone's "linked"), so the
 * dialog only releases its login; past this, an unfinished one is turned off.
 * One still loading has shown nobody a login yet, so it is given more time.
 */
export const RELEASED_LOGIN_MS = 180_000;

type GatewayOptions = {
  platform?: () => HostPlatform;
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
  /**
   * `messageId` asks the agent to report what the turn answers for it
   * (`turn_answer`), as the hosted phone lane does.
   */
  sendMessage: (
    workspaceId: string,
    sessionId: string,
    message: string,
    userText?: UserTextTags,
    messageId?: string
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
  /** Tells the user outside any chat: a lost link, a sender waiting. `key` dedupes repeats. */
  notifyUser?: (
    platform: MessagingPlatformId,
    title: string,
    body: string,
    key: string
  ) => void;
  /** A platform came up: what waited on its link can go. */
  onPlatformConnected?: (platform: MessagingPlatformId) => void;
  /** The failure-reply throttle's clock; tests pass a fake one. */
  now?: () => number;
  /** The app's language (a BCP 47 tag), for lines the bot itself words. */
  appLanguage?: () => string | null;
  /**
   * A platform started or stopped, so the messaging tools just came or went.
   * For the running agent, not the pane: the send tools are withheld from
   * `tools/list` while no platform runs.
   */
  onToolAvailabilityChanged?: () => void;
  /**
   * The chat apps' home bots: the one bot each self lane answers with. Kept
   * by the bot service; absent in a build without bots.
   */
  homeBots?: {
    /** The lane's home bot, or null while none is set (or it was deleted). */
    get: (lane: SelfLanePlatform) => string | null;
    /** The one setter; throws for a bot that does not exist. */
    set: (lane: SelfLanePlatform, botId: string) => void;
    /**
     * The home bot, set first when there is none: the first bot made from the
     * app's agent template, else a new one. Null when none can be had.
     */
    ensure: (lane: SelfLanePlatform) => string | null;
  };
  /**
   * While onboarding runs, a lane that links waits for its default: the bot
   * onboarding makes for it is the one (see settleSelfLaneDefaults).
   */
  deferSelfLaneDefaults?: () => boolean;
  /**
   * Whether the session is mid-turn by any hand. A turn the user started in
   * the app is theirs there: a self-lane message waits for it to end.
   */
  isSessionBusy?: (workspaceId: string, sessionId: string) => boolean;
  /** A turn is about to be sent for a chat: its ending is owed there, even across a restart. */
  noteChannelTurn?: (sessionId: string, channel: TurnChannel) => void;
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

/** What a send threads against: the route's current message when undefined, none when null. */
type ReplyTarget = Record<string, string> | null;

/** A chat message's id for the agent, so it names what a turn answers for it. */
const chatMessageId = (): string => `chat-${randomUUID()}`;

/** The user's own chat on a chat app, answered by that app's home bot. */
const isSelfLane = (
  platformId: MessagingPlatformId
): platformId is SelfLanePlatform => appOfSelfLane(platformId) != null;

/**
 * How long a bot asking to connect a chat app stays its claimant: the lane
 * linking inside this makes that bot its home bot (see takeLinkClaim).
 */
const LINK_CLAIM_MS = 30 * 60_000;

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

/** After a start, the connectors get this long to come up before a retry. */
const OUTBOX_STARTUP_DELAY_MS = 60_000;
/**
 * A long turn in the user's own chat: the model's latest update line goes
 * out once the chat has heard nothing for PROGRESS_LINE_EVERY_MS, and the
 * generic still-working note only after PROGRESS_NOTE_EVERY_MS of silence.
 */
const PROGRESS_LINE_EVERY_MS = 5 * 60_000;
const PROGRESS_NOTE_EVERY_MS = 10 * 60_000;
const PROGRESS_CHECK_MS = 30_000;
/** Narration longer than this is the model thinking aloud, not an update. */
const PROGRESS_LINE_MAX_CHARS = 500;

/** What the user's own chat has heard during a long turn. */
type TurnProgress = {
  /** When the chat last heard anything: the turn's start, a line or a note. */
  heardAt: number;
  /** The model's latest update not yet sent; a newer one replaces it. */
  line: string | null;
  /** The tool the turn started last, for the note to name what it is doing. */
  tool: string | null;
};

/** A conversation in flight: which session it owns and what it's waiting on. */
export type Route = {
  platform: MessagingPlatformId;
  chatId: string;
  sessionId: string;
  workspaceId: string;
  /** Approved sender who owns this conversation, so revoking can find it. */
  userId: string;
  /** The sender's display name, for telling the user who went unanswered. */
  userName: string | null;
  replyContext?: Record<string, string>;
  /**
   * Text of the turn's latest assistant message only. Narration before a
   * tool call is the model talking to itself; only the last message is the
   * reply.
   */
  buffer: string;
  /** Which assistant message the buffer is from. See handleAgentEvent. */
  bufferMessageId: string | null;
  /**
   * A complete <reply> block written earlier in the turn, kept when a tool
   * round clears the buffer: a model that answers and then files a memory
   * note ends its turn with an empty buffer.
   */
  taggedReply: string | null;
  /**
   * Words the model was told to go on from (promised_work_recovery). The chat
   * gets one message a turn: these stand in if nothing follows, and a report
   * in them leads what does.
   */
  heldWords: string | null;
  /** True between sending a prompt and the turn reaching idle or error. */
  busy: boolean;
  /** When the current turn was dispatched, for stuck-turn recovery. */
  busySince: number;
  /** Messages that arrived mid-turn, sent in order once the turn finishes. */
  queue: Array<{
    text: string;
    replyContext?: Record<string, string>;
    /** The app's own hidden note (relayNote), not the chat's words. */
    note?: true;
  }>;
  /** Whether this turn has already said the queue is full. */
  queueFullNotified: boolean;
  /**
   * True when this route delivers into a bot's forever chat. Bot routes for
   * different chats share one session, so busyness is judged per session and
   * prompts carry the sender, not just the text.
   */
  viaBot: boolean;
  /**
   * The user's own chat (a self lane): the owner is the audience, so there
   * are no auto-reply rules and no filter for words meant for the user.
   */
  owner: boolean;
  /** The sender line prefixed to prompts on bot routes. */
  senderLabel: string;
  /** Rules preamble still owed to the first dispatched prompt, then cleared. */
  pendingIntro: string | null;
  /**
   * A failed turn's line still being worded (the upgrade link is fetched).
   * The turn does not finish until it has gone, so nothing overtakes it.
   */
  failureReply: Promise<void> | null;
  /**
   * This turn has reached the chat: a reply, the agent's own send, or its
   * decision not to answer (NO_REPLY). A turn that closes without any of
   * these has said nothing, and the chat hears why (chatFailureOf).
   */
  delivered: boolean;
  /** The user's own chat hears, now and then, that a long turn is still going. */
  progressTimer: ReturnType<typeof setInterval> | null;
  progress: TurnProgress | null;
  /** Each message this turn answers, by the id the agent names it with: what its answer threads against. */
  answerContexts: Map<string, Record<string, string> | undefined>;
  /** The user joined the turn from the app: the chat is owed only the answer it was waiting for. */
  appJoined: boolean;
  /** The route's send still going, if any: the next waits for it, so the chat gets them in order. */
  sending: Promise<void> | null;
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
  /** sessionId -> when its last chat-app turn ended. */
  private readonly chatTurnEndedAt = new Map<string, number>();
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

  /** Armed while a released login may still land; see RELEASED_LOGIN_MS. */
  private readonly releasedLogins = new Map<
    MessagingPlatformId,
    ReturnType<typeof setTimeout>
  >();

  /** Armed while a platform is connecting; see CONNECT_DEADLINE_MS. */
  private readonly connectDeadlines = new Map<
    MessagingPlatformId,
    NodeJS.Timeout
  >();

  /** Everything seen and sent, oldest first, reloaded from the last run. */
  private readonly messageLog: ChatLogEntry[] =
    readStoredMessageLog() as ChatLogEntry[];
  /** Messages still owed to a chat (ChatOutbox), across restarts too. */
  private readonly outbox = new ChatOutbox({
    now: () => this.options.now?.() ?? Date.now(),
    read: readStoredOutbox,
    write: writeStoredOutbox,
    send: (message) => this.sendOwed(message),
    waitingOnLink: (platform) => {
      const state = this.states.get(platform)?.state;
      return (
        state === "connecting" ||
        state === "needs_login" ||
        state === "rate_limited" ||
        state === "syncing" ||
        // Down but being retried: what it owes waits out the recovery.
        this.supervisor.retrying(platform)
      );
    },
    giveUp: (message) => this.tellUndelivered(message),
  });

  /** Armed by appendLog; one write covers a burst of messages. */
  private logSaveTimer: NodeJS.Timeout | null = null;

  /** The one outer retry loop for lanes that should be connected and aren't. */
  private readonly supervisor = new LaneSupervisor({
    now: () => Date.now(),
    random: Math.random,
    shouldRun: (id) => this.shouldRun(id),
    restart: (id) => this.restartPlatform(id),
    diskSpaceBack,
    userActive,
    notifyDown: (id) => void this.tellLaneDown(id),
    tellNeedsUser: (id) => void this.tellLaneBlocked(id),
    watchHints: watchLaneHints,
    changed: () => this.options.emitChanged(),
    log: (line) => console.log(`[messaging] ${line}`),
  });

  /** A bot that asked to connect a chat app, by the lane it would answer. */
  private readonly linkClaims = new Map<
    SelfLanePlatform,
    { botId: string; at: number }
  >();

  /** Platforms whose lost link the user heard of this run: once each launch, until it is back. */
  private readonly linkLossTold = new Set<MessagingPlatformId>();

  /** Waiting-chat notices: when the last went out, what waits for the gap, its timer. */
  private waitingToldAt = 0;
  private readonly waitingQueue: WaitingNotice[] = [];
  private waitingTimer: ReturnType<typeof setTimeout> | null = null;
  /** Chats told about this run, beside the row's mark. */
  private readonly toldThisRun = new Set<string>();

  /** What each chat was already told about failed turns; see FailureReplyThrottle. */
  private readonly failureThrottle: FailureReplyThrottle;

  constructor(private readonly options: GatewayOptions) {
    this.failureThrottle = new FailureReplyThrottle(options.now);
    // Owed from the last run: tried once the connectors have had a moment.
    if (this.outbox.size > 0) this.outbox.schedule(OUTBOX_STARTUP_DELAY_MS);
  }

  /**
   * Bring every enabled+configured platform up. Called once at startup and
   * again whenever credentials or enable flags change.
   */
  async syncConnectors(): Promise<void> {
    const { gatewayEnabled } = readGatewaySettings();

    for (const entry of MESSAGING_PLATFORM_CATALOG) {
      if (
        this.options.platform?.() === "web-host" &&
        !entry.id.startsWith("abacus_")
      )
        continue;
      const shouldRun = gatewayEnabled && this.shouldRun(entry.id);

      // A connector in `error` still sits in the map looking "running". A
      // sync is the user's Connect or a settings change: restart it, at most
      // once per LANE_HINT_GAP_MS. `needs_login` is healthy and never restarted.
      if (
        shouldRun &&
        this.connectors.has(entry.id) &&
        this.states.get(entry.id)?.state === "error"
      ) {
        this.supervisor.retryNow(entry.id, LANE_HINT_GAP_MS);
        continue;
      }

      const isRunning = this.connectors.has(entry.id);

      if (shouldRun && !isRunning) this.startPlatform(entry.id);
      else if (!shouldRun && isRunning) await this.stopPlatform(entry.id);
      if (!shouldRun) this.supervisor.forget(entry.id);
    }

    this.options.emitChanged();
  }

  /** Switched on, configured, and messaging itself on. */
  private shouldRun(platformId: MessagingPlatformId): boolean {
    return (
      readGatewaySettings().gatewayEnabled &&
      isPlatformEnabled(platformId) &&
      isPlatformConfigured(platformId)
    );
  }

  /** The supervisor's retry: a fresh connector and page, as a relaunch would. */
  private async restartPlatform(
    platformId: MessagingPlatformId
  ): Promise<void> {
    await this.stopPlatform(platformId);
    // dispose() may have run while the old connector stopped.
    if (this.disposed) return;
    if (this.shouldRun(platformId) && !this.connectors.has(platformId))
      this.startPlatform(platformId);
    this.options.emitChanged();
  }

  /** Set by dispose(): nothing starts a lane after it. */
  private disposed = false;

  async dispose(): Promise<void> {
    this.disposed = true;
    this.supervisor.dispose();
    this.outbox.dispose();
    for (const route of this.routes.values()) this.stopWatchingProgress(route);
    for (const timer of this.releasedLogins.values()) clearTimeout(timer);
    this.releasedLogins.clear();
    this.dropWaitingNotices();
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
    // a reconnect handler, say). stop() is what releases them.
    await this.awaitStop(connector);

    // Logged, not just shown: the pane's string is overwritten by the next
    // attempt, and a log dump must still show the failure.
    console.log(`[messaging] ${platformId}: failed: ${message}`);
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
    if (
      this.options.platform?.() === "web-host" &&
      !platformId.startsWith("abacus_")
    )
      return null;
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
      onState: (
        state: MessagingPlatformState,
        errorMessage?: string,
        failure?: LaneFailure
      ) => {
        if (!current()) return;
        this.setState(platformId, state, errorMessage, failure);
      },
      onLog: (line: string) => {
        console.log(`[messaging] ${line}`);
      },
      onSelfLinked: () => {
        if (!current()) return;
        // The bot's chat or install page, still up for a link that just landed.
        this.discordSessionFor(platformId)?.endPresentation();
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
        return new AbacusChannelsConnector(
          callbacks,
          "discord",
          this.options.platform?.()
        );
      case "abacus_telegram":
        return new AbacusChannelsConnector(
          callbacks,
          "telegram",
          this.options.platform?.()
        );
      default:
        return null;
    }
  }

  private setState(
    platformId: MessagingPlatformId,
    state: MessagingPlatformState,
    error?: string,
    failure?: LaneFailure
  ): void {
    // The login poll re-reports an unchanged state every tick; nobody
    // downstream needs to hear it again.
    const previous = this.states.get(platformId);
    if (previous?.state === state && previous.error === (error ?? null)) return;

    // Leaving `connecting` at all (connected, failed, switched off) settles
    // the question the deadline was asking.
    if (state !== "connecting") this.clearConnectDeadline(platformId);
    // A released login that landed is kept.
    if (state === "connected" || state === "syncing")
      this.clearReleasedLogin(platformId);
    // What a connector that made it back up still owes a chat goes now.
    if (state === "connected") {
      this.linkLossTold.delete(platformId);
      if (this.outbox.owes(platformId)) this.outbox.schedule(0);
      this.options.onPlatformConnected?.(platformId);
    }
    if (state === "needs_login" && readPlatformLinkLost(platformId))
      void this.tellLinkLost(platformId);
    // Every transition to the main log, so an export says what the card showed.
    console.log(
      `[messaging] ${platformId}: ${previous?.state ?? "(new)"} -> ${state}` +
        (error != null && error.length > 0 ? ` (${error})` : "")
    );
    this.states.set(platformId, { state, error: error ?? null });
    this.supervisor.noteState(platformId, state, failure);
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
        (file) => `[attachment: ${file.name} saved to ${modelPath(file.path)}]`
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

    // Another AbacusBot's reply in the user's own chat is not the user
    // talking. The connector drops the signed ones; this catches the rest.
    if (isSelf && looksLikeBotOutput(message.text)) {
      console.log(
        `[messaging] ${platformId}: a message in the user's own chat reads as another bot's output, not answering it`
      );
      return;
    }

    // Off, only the user's own chat is answered. Everyone else waits for the
    // user's decision: being off never approves anyone, because the approved
    // list is exactly who gets answered the moment it is switched on.
    if (
      !settings.respondToInbound &&
      !(isSelf && this.options.homeBots != null)
    ) {
      // The user's own chat is never someone to approve.
      if (!isSelf) this.holdSender(platformId, message, { tell: false });
      return;
    }

    // Still inside a cool-off from the breaker below. Messages are logged;
    // when it lapses the lane answers again with nothing to re-enable.
    if (Date.now() < settings.autoReplyPausedUntil) {
      if (!this.pauseNoticed) {
        this.pauseNoticed = true;
        console.log(
          "[messaging] auto-reply is paused after a suspected loop; messages are logged, not answered"
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

    const decision = this.answerDecision(platformId, message, isSelf);
    if (decision !== "answer") {
      this.holdSender(platformId, message, {
        tell: !isSelf,
        takeBack: decision === "takeBack",
      });
      return;
    }

    // A bot wins over the per-sender gateway sessions: the user's own chat
    // goes to the app's home bot (made now if it was deleted), everyone else
    // to the bot on their row, falling back to the general auto-reply bot.
    const pairedRow = findPairing(platformId, message.userId);
    const routeBot = isSelf
      ? isSelfLane(platformId)
        ? (this.options.homeBots?.ensure(platformId) ?? null)
        : null
      : (pairedRow?.botId ?? settings.botId);
    let route: Route | null;

    if (routeBot != null && this.options.openBotChat != null) {
      route = await this.ensureBotRoute(platformId, message, routeBot, isSelf);
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
      route = await this.ensureRoute(platformId, message, workspaceId, isSelf);
    }
    if (route == null) return;

    // A chat linked before WhatsApp finished syncing its chat list was named
    // by its number, and the label is fixed at route creation; once the name
    // arrives, the transcript should stop reading like a phone bill.
    const named = senderLabel(platformId, message);
    if (named !== route.senderLabel && message.userName != null)
      route.senderLabel = named;
    if (message.userName != null) route.userName = message.userName;

    // Busyness belongs to the session, not the route: bot routes for
    // different chats share one session, and two prompts at once would mix
    // two turns' output into one buffer.
    const active = this.routesBySession.get(route.sessionId);

    // A turn someone started in the app is theirs there; a message steered
    // into it would carry its answer off to this chat.
    const appTurn =
      active?.busy !== true &&
      this.options.isSessionBusy?.(route.workspaceId, route.sessionId) === true;
    // Claimed so the turn's idle reaches here and starts the queue.
    if (appTurn && active == null)
      this.routesBySession.set(route.sessionId, route);

    // A second message mid-turn is queued, reply context included, rather
    // than dropped or interleaved.
    if ((active != null && active.busy) || appTurn) {
      // A follow-up from the chat whose turn is running steers that turn;
      // other chats wait, since theirs is a different conversation.
      if (active === route && !appTurn && !route.appJoined) {
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
    owner: boolean
  ): Promise<Route | null> {
    const key = `${platformId}:${message.chatId}`;

    const pending = this.pendingRoutes.get(key);
    if (pending != null) return pending;

    const creating = (async (): Promise<Route | null> => {
      let handle: { workspaceId: string; sessionId: string };
      try {
        // The bot's conversation with this chat, revived if dead. The owner's
        // own chat goes to the forever chat, where they see it: nobody else
        // is ever in it. So does a build wired without sender chats.
        handle =
          this.options.openBotSenderChat != null && !owner
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
        userName: message.userName,
        buffer: "",
        bufferMessageId: null,
        taggedReply: null,
        heldWords: null,
        busy: false,
        busySince: 0,
        queue: [],
        queueFullNotified: false,
        viaBot: true,
        owner,
        senderLabel: senderLabel(platformId, message),
        pendingIntro:
          "intro" in handle && typeof handle.intro === "string"
            ? handle.intro
            : null,
        failureReply: null,
        delivered: false,
        progressTimer: null,
        progress: null,
        answerContexts: new Map(),
        appJoined: false,
        sending: null,
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
    workspaceId: string,
    owner: boolean
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
      workspaceId,
      owner
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
    workspaceId: string,
    owner: boolean
  ): Promise<Route | null> {
    const existing = this.routes.get(key);

    const session = this.options.createAgentSession(workspaceId);
    const label = `${platformLabel(platformId)} · ${message.userName ?? message.userId}`;
    this.options.updateSessionLabel(workspaceId, session.id, label);

    const route: Route = {
      platform: platformId,
      chatId: message.chatId,
      sessionId: session.id,
      workspaceId,
      userId: message.userId,
      userName: message.userName,
      buffer: "",
      bufferMessageId: null,
      taggedReply: null,
      heldWords: null,
      busy: false,
      busySince: 0,
      queue: [],
      queueFullNotified: false,
      viaBot: false,
      owner,
      senderLabel: "",
      pendingIntro: null,
      failureReply: null,
      delivered: false,
      progressTimer: null,
      progress: null,
      answerContexts: new Map(),
      appJoined: false,
      sending: null,
    };

    const { autoApproveTools } = readGatewaySettings();
    const started = await this.options.startSession(
      workspaceId,
      session.id,
      // Nobody is at the keyboard to approve a tool for a remote turn; the
      // pairing allowlist is what keeps Bypass from being an open door.
      autoApproveTools ? readDefaultAgentMode() : AgentMode.AcceptEdits
    );

    // The start retried already: the chat hears it in its own words, as any
    // turn no agent took, never the start's raw error.
    if (!started.success) {
      console.log(
        `[messaging] ${platformId}:${message.chatId} agent did not start: ${started.error ?? "unknown"}`
      );
      await this.replyToFailure(
        { ...route, replyContext: message.replyContext },
        { code: "not_started" }
      );
      return null;
    }

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
    // Every route bound to it, not just the registered one: bot routes for
    // several chats can share a session.
    for (const [key, route] of this.routes) {
      if (route.sessionId === sessionId) this.routes.delete(key);
    }
  }

  private dispatch(
    route: Route,
    text: string,
    replyContext?: Record<string, string>,
    note = false
  ): void {
    route.busy = true;
    route.busySince = Date.now();
    route.buffer = "";
    route.bufferMessageId = null;
    route.taggedReply = null;
    route.heldWords = null;
    // A fresh turn may fill the queue again, and deserves to say so again.
    route.queueFullNotified = false;
    route.delivered = false;
    route.appJoined = false;
    route.answerContexts.clear();
    // Set at dispatch time, not arrival: the context must describe the message
    // this turn is answering, not one that queued behind it.
    route.replyContext = replyContext;
    // Bot routes share one session, so the dispatching route claims the event
    // stream for its turn. A no-op for ordinary routes.
    this.routesBySession.set(route.sessionId, route);
    // The app's own note: hidden, unframed, and never echoed as the chat's.
    if (note) {
      this.options.noteChannelTurn?.(route.sessionId, {
        platform: route.platform,
        chatId: route.chatId,
        owner: route.owner,
        userName: route.userName,
      });
      this.watchProgress(route);
      this.options.sendMessage(
        route.workspaceId,
        route.sessionId,
        text,
        { systemReminder: true, operator: { kind: "environment-notice" } },
        this.answerId(route, replyContext)
      );
      return;
    }
    // A bot answers many chats from one conversation, so the prompt says
    // which one is talking.
    const framed = route.viaBot
      ? frameChannelMessage(route.senderLabel, text)
      : text;
    // The rules preamble rides on the first prompt, never as a message of its
    // own, so no inbound message is seen before the rules; a one-line
    // reminder on every later turn keeps them in front of the model.
    const prompt =
      route.pendingIntro != null
        ? `${route.pendingIntro}\n\n${framed}`
        : route.viaBot && !route.owner
          ? `${REPLY_REMINDER}\n\n${framed}`
          : framed;
    const userText: UserTextTags | undefined =
      prompt === framed
        ? undefined
        : {
            operator: {
              kind:
                route.pendingIntro != null
                  ? "auto-reply-intro"
                  : "auto-reply-reminder",
              visibleFrom: prompt.length - framed.length,
            },
          };
    route.pendingIntro = null;
    // Echoed at dispatch, not arrival, so a queued message lands in the
    // transcript next to the turn it started. The rules ride along to the
    // model but never into the transcript: they are the same paragraph every
    // turn, and reading them is not reading the conversation.
    this.options.emitUserMessage(route.workspaceId, route.sessionId, framed);
    this.options.noteChannelTurn?.(route.sessionId, {
      platform: route.platform,
      chatId: route.chatId,
      owner: route.owner,
      userName: route.userName,
    });
    this.watchProgress(route);
    this.options.sendMessage(
      route.workspaceId,
      route.sessionId,
      prompt,
      userText,
      this.answerId(route, replyContext)
    );
  }

  /** A new message's id for the agent, remembering what its answer threads against. */
  private answerId(
    route: Route,
    replyContext: Record<string, string> | undefined
  ): string {
    const id = chatMessageId();
    route.answerContexts.set(id, replyContext);
    return id;
  }

  /**
   * A message for the turn already running on this route; the host steers
   * the turn with it. An answer the turn finished before it lands goes out
   * on the agent's `turn_answer` (handleAgentEvent). The reply context moves
   * to this message so the answer threads against the latest thing they said.
   */
  private steer(
    route: Route,
    text: string,
    replyContext?: Record<string, string>
  ): void {
    route.replyContext = replyContext ?? route.replyContext;
    const prompt = route.viaBot
      ? frameChannelMessage(route.senderLabel, text)
      : text;
    this.options.emitUserMessage(route.workspaceId, route.sessionId, prompt);
    this.options.sendMessage(
      route.workspaceId,
      route.sessionId,
      prompt,
      undefined,
      this.answerId(route, replyContext ?? route.replyContext)
    );
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

    // The message moved off a failed model to RouteLLM - Open: the user's own
    // chat hears why before the answer; someone else's chat gets the answer.
    if (event.type === "notification") {
      const moved = event.actions?.find(
        (action) => action.type === "moved-to-abacus"
      );
      if (moved != null) void this.tellMove(route, moved);
      const job = event.actions?.find(
        (action) => action.type === "background-job"
      );
      if (job != null) void this.tellBackgroundJob(route, job.cause);
      return;
    }

    // A steer landed behind an answer the turn had finished: that answer goes
    // now, once, since the steer's answer would replace it as the reply.
    if (event.type === "turn_answer") {
      if (!route.busy) return;
      const answered = event.messageIds.at(-1);
      this.flushReply(
        route,
        event.text,
        answered != null && route.answerContexts.has(answered)
          ? (route.answerContexts.get(answered) ?? null)
          : undefined
      );
      route.bufferMessageId = null;
      // The steered message is still owed its own answer, or the empty-reply
      // line; a turn's own settled reply owes nothing more (flushReply set it).
      if (event.settled !== true) route.delivered = false;
      // The chat just heard the answer: progress counts from here, and an update written before it is stale.
      if (route.progress != null) {
        route.progress.heardAt = Date.now();
        route.progress.line = null;
      }
      return;
    }

    // The app's message joined the turn: any answer owed to the chat went
    // just before, as turn_answer. A chat steer sent before the join is ours.
    if (
      event.type === "user_message_steered" &&
      route.appJoined &&
      !(event.messageId != null && route.answerContexts.has(event.messageId))
    ) {
      if (route.busy) this.leaveToApp(route);
      return;
    }

    // The turn goes on past these words, so nothing is sent yet.
    if (event.type === "promised_work_recovery") {
      // Already sent (a settled turn_answer): nothing to hold.
      const words = outgoingWords(route.buffer);
      route.heldWords = words.length > 0 ? words : route.heldWords;
      route.buffer = "";
      route.bufferMessageId = null;
      route.taggedReply = null;
      return;
    }

    // Text before a tool call is narration, not the reply, except a reply the
    // model already wrapped, which a later tool call must not throw away. The
    // text before suggest_tasks is the reply: that call can end the turn.
    if (event.type === "tool_call_start") {
      if (isSuggestTasksTool(event.toolName)) return;
      const tagged = lastTaggedReply(route.buffer);
      // In the user's own chat, the narration is the turn's latest update.
      if (route.progress != null) {
        route.progress.tool = event.toolName;
        const line = tagged == null ? outgoingWords(route.buffer).trim() : "";
        if (
          line !== "" &&
          line !== "NO_REPLY" &&
          line.length <= PROGRESS_LINE_MAX_CHARS
        ) {
          route.progress.line = line;
          this.tickProgress(route);
        }
      }
      route.taggedReply = tagged ?? route.taggedReply;
      route.buffer = "";
      route.bufferMessageId = null;
      return;
    }

    // A turn ends only where the TurnLedger closes it (noteTurnClosed), never
    // on an event read here. An idle with no turn open (a run the agent
    // started on its own) only frees the session for what queued behind it.
    if (
      event.type === "status_changed" &&
      event.status === AgentStatus.Idle &&
      !route.busy
    )
      this.startQueued(route);
  }

  /**
   * The user wrote in the app to a session a relayed turn holds. Once their
   * message joins the turn, the rest is theirs in the app; the chat still
   * gets an answer it was owed (turn_answer), or the whole reply when the
   * turn ends before their message joins it.
   */
  noteAppMessage(sessionId: string): void {
    const route = this.routesBySession.get(sessionId);
    if (route == null || !route.busy || route.appJoined) return;
    console.log(
      `[messaging] ${route.platform}:${route.chatId} turn joined from the app; the rest of it stays there`
    );
    route.appJoined = true;
    this.stopWatchingProgress(route);
  }

  /** The chat's answer has gone; the rest of the turn is the app's. */
  private leaveToApp(route: Route): void {
    route.busy = false;
    route.appJoined = false;
    route.buffer = "";
    route.bufferMessageId = null;
    route.taggedReply = null;
    route.heldWords = null;
    route.answerContexts.clear();
  }

  /**
   * Send what the turn has produced so far (`written`, the buffer unless the
   * agent named its answer) and clear the buffer.
   */
  private flushReply(
    route: Route,
    written = route.buffer,
    replyContext?: ReplyTarget
  ): void {
    // The last round's words win when they carry a reply; otherwise the
    // reply wrapped before a tool round is what the model meant to send.
    const reply =
      lastTaggedReply(written) == null && route.taggedReply != null
        ? route.taggedReply
        : outgoingWords(written);
    const held = route.heldWords;
    route.buffer = "";
    route.taggedReply = null;
    route.heldWords = null;

    // The agent's way of sending nothing; the sentinel must never reach a chat.
    if (reply === "NO_REPLY") {
      route.delivered = true;
      if (held != null) this.deliver(route, held, replyContext);
      return;
    }

    // Words addressed to the user, about to be said to their friend. The
    // preamble forbids it, but an instruction the model can forget is not a
    // guarantee against the one thing this feature must never do. In the
    // owner's own chat, words for the user are the point.
    const meta = route.owner ? null : commentaryMarker(reply);
    if (meta != null) {
      console.log(
        `[messaging] held back a reply meant for the user (${meta}) on ` +
          `${route.platform}:${route.chatId}`
      );
      // Not silence, which reads as the user ignoring them: the deferral the
      // preamble already prescribes goes instead.
      this.deliver(route, DEFERRAL, replyContext);
      return;
    }

    const words = joinHeld(held, reply);
    if (words.length > 0) {
      this.deliver(
        route,
        words.length > MAX_REPLY_LENGTH
          ? `${words.slice(0, MAX_REPLY_LENGTH)}\n\n[truncated]`
          : words,
        replyContext
      );
    }
  }

  /**
   * Send the words and show them. What the transcript shows is what left the
   * app, not what the model wrote around it: on a bot route the turn's own
   * text is withheld (see relayingSession) precisely so this stands alone.
   */
  private deliver(route: Route, text: string, replyTo?: ReplyTarget): void {
    route.delivered = true;
    const words = forChat(text, route.platform);
    const replyContext =
      replyTo === undefined ? route.replyContext : (replyTo ?? undefined);
    this.inRouteOrder(route, () =>
      this.safeSend(route.platform, route.chatId, words, replyContext)
    );
    if (!route.viaBot) return;
    this.options.emitAgentMessage?.(
      route.workspaceId,
      route.sessionId,
      `${RESPONSE_LABEL} ${words}`
    );
  }

  /**
   * The app's hidden note (a bot's answer to its request) for a turn the
   * user started in their own chat on an app: it runs as a turn on that
   * chat's route, so the bot's reply goes back to that chat, not the app.
   * Waits behind a running turn like any message. Only the user's own chat,
   * never a contact's; false when that chat has no route here (the caller
   * then tells the app's chat).
   */
  relayNote(
    sessionId: string,
    channel: { platform: string; chatId: string },
    note: string
  ): boolean {
    const route = this.routes.get(`${channel.platform}:${channel.chatId}`);
    if (route == null || route.sessionId !== sessionId || !route.owner)
      return false;
    const active = this.routesBySession.get(route.sessionId);
    const appTurn =
      active?.busy !== true &&
      this.options.isSessionBusy?.(route.workspaceId, route.sessionId) === true;
    if (appTurn && active == null)
      this.routesBySession.set(route.sessionId, route);
    // Never dropped for a full queue: it is the answer the user is owed.
    if ((active != null && active.busy) || appTurn)
      route.queue.push({ text: note, note: true });
    else this.dispatch(route, note, undefined, true);
    return true;
  }

  /** Whether a chat-app conversation is bound to this session. */
  servesSession(sessionId: string): boolean {
    return this.routesBySession.has(sessionId);
  }

  /**
   * Is this session mid-turn on a bot route? Such a turn's text is thinking
   * wrapped around a <reply> tag, addressed to nobody: the transcript shows
   * the delivered words instead. False between turns, so the user talking to
   * the bot in its own chat still sees ordinary answers.
   */
  relayingSession(sessionId: string): boolean {
    const route = this.routesBySession.get(sessionId);
    return route != null && route.viaBot && route.busy && !route.appJoined;
  }

  /** The move's line, in the user's own chat only. */
  private async tellMove(
    route: Route,
    action: { provider?: string; label?: string; target?: string }
  ): Promise<void> {
    const own = this.selfChatOf(route.platform);
    if (
      own == null ||
      own.platform !== route.platform ||
      own.chatId !== route.userId
    )
      return;
    const words = await channelWords(
      channelLocale(
        readUserLanguage()?.name ?? null,
        this.options.appLanguage?.() ?? null
      )
    );
    this.deliver(route, chatLineForMove(words, action));
  }

  /** A job this chat's agent started finished after its reply went. */
  private async tellBackgroundJob(
    route: Route,
    cause: string | undefined
  ): Promise<void> {
    const own = this.selfChatOf(route.platform);
    if (
      own == null ||
      own.platform !== route.platform ||
      own.chatId !== route.userId
    )
      return;
    const words = await channelWords(
      channelLocale(
        readUserLanguage()?.name ?? null,
        this.options.appLanguage?.() ?? null
      )
    );
    this.deliver(route, chatLineForBackgroundJob(words, cause));
  }

  /**
   * Tell the chat its turn failed, in chatReplyForFailure's words: the user's
   * own chat gets the line; someone else's chat gets nothing, and the user's
   * own chat on that platform hears who went unanswered.
   */
  private async replyToFailure(
    route: Route,
    failure: TurnFailure
  ): Promise<void> {
    const own = this.selfChatOf(route.platform);
    const isOwn =
      own != null &&
      own.platform === route.platform &&
      own.chatId === route.userId;
    const words = await channelWords(
      channelLocale(
        readUserLanguage()?.name ?? null,
        this.options.appLanguage?.() ?? null
      )
    );
    // Someone else's chat is never left on silence: a neutral line, nothing
    // about why. A turn that merely said nothing may have meant to, so that
    // one is the user's call, told to them below.
    if (!isOwn && failureKind(failure) !== "empty")
      this.deliver(route, words.t("outcome.channel.contactNeutral"));
    if (!isOwn && own == null) {
      console.log(
        `[messaging] ${route.platform}:${route.chatId} failed turn not reported: the platform has no own chat`
      );
      return;
    }

    const account = accountKind();
    const offering = wantsUpgradeUrl(failure, account);
    // Fetched afresh every time: a link that failed while offline is asked
    // for again, and the bot's own upgrade page stands in when it cannot be.
    const [upgradeUrl, billing] = await Promise.all([
      offering
        ? withinMs(fetchUpgradeUrl("channel"), UPGRADE_URL_WAIT_MS)
        : null,
      offering ||
      failureKind(failure) === "upgrade-abacus" ||
      failureKind(failure) === "model-gone" ||
      failureKind(failure) === "cut-off"
        ? withinMs(fetchBillingPlan(false), UPGRADE_URL_WAIT_MS)
        : null,
    ]);
    // The offer is throttled per chat it lands in, always the user's own.
    const ownChatKey = isOwn
      ? `${route.platform}:${route.chatId}`
      : `${own.platform}:${own.chatId}`;
    const fallback = botUpgradePage("channel");
    const line = chatReplyForFailure(
      failure,
      "own",
      account,
      words,
      {
        upgradeUrl: upgradeUrl ?? fallback,
        // A paid plan buys credits, never the free plan's upgrade page.
        topUpUrl:
          billing?.topUpUrl ??
          (account === "paid"
            ? ABACUS_BUY_CREDITS_URL
            : (upgradeUrl ?? fallback)),
        billing,
        // Held free credits are unlocked by a phone check, never a plan.
        ...(cachedAbacusAccount()?.free_credits_held === true && {
          verifyUrl: ABACUS_VERIFY_PHONE_URL,
        }),
      },
      // A contact went unanswered: the user hears the whole line every time,
      // what stopped it and the way on, never the shortened reminder.
      isOwn && this.failureThrottle.repeat(ownChatKey, failureKind(failure))
    );
    if (line == null) return;
    if (failureKind(failure) === "cut-off")
      reportFunnelStep("cutoff_chat_told", route.platform);
    if (isOwn) this.deliver(route, line);
    // Someone else's chat hears nothing; the user's own chat hears who.
    else
      this.deliverToSelf(
        own,
        contactFailureNotice(words, route.userName, line, failureKind(failure))
      );
  }

  /**
   * The user's own chat on a platform, as something a notice can reach: the
   * platform's self chat, else the shared Abacus bot's DM for that app (you
   * cannot DM yourself on Discord). Null when there is none to reach.
   */
  private selfChatOf(
    platformId: MessagingPlatformId
  ): { platform: MessagingPlatformId; chatId: string } | null {
    const own = this.connectors.get(platformId)?.selfChatId?.() ?? null;
    if (own != null && own.length > 0)
      return { platform: platformId, chatId: own };
    const sharedId = SHARED_BOT_PLATFORM_OF[platformId];
    if (sharedId == null) return null;
    const shared = this.connectors.get(sharedId)?.selfChatId?.() ?? null;
    return shared != null && shared.length > 0
      ? { platform: sharedId, chatId: shared }
      : null;
  }

  /** Send a notice to the user's own chat, shown in its transcript if routed. */
  private deliverToSelf(
    own: { platform: MessagingPlatformId; chatId: string },
    text: string
  ): void {
    const route = this.routes.get(`${own.platform}:${own.chatId}`);
    if (route != null) {
      // Not a reply to anything said there, nor the turn's answer.
      const delivered = route.delivered;
      this.deliver(route, text, null);
      route.delivered = delivered;
      return;
    }
    void this.safeSend(own.platform, own.chatId, forChat(text, own.platform));
  }

  /** Word and send the turn's failure line; the turn ends once it has gone. */
  private startFailureReply(route: Route, failure: TurnFailure): void {
    route.failureReply = this.replyToFailure(route, failure)
      .catch((error: unknown) => {
        console.error(
          `[messaging] ${route.platform}:${route.chatId} failure reply failed:`,
          error
        );
      })
      .finally(() => {
        route.failureReply = null;
      });
  }

  /**
   * The session's turn closed: the one place a chat's turn ends. Every turn
   * the gateway dispatches is closed exactly once by the TurnLedger (the
   * agent's outcome, a Stop, the watchdog, the agent going away), so the
   * route is freed whatever ended it and the chat hears one ending: the
   * reply, or the failure line, never silence. A Stop ends it quietly.
   */
  noteTurnClosed(record: TurnRecord): void {
    if (record.kind === "app_closed") {
      this.oweInterrupted(record);
      return;
    }
    const route = this.routesBySession.get(record.sessionId);
    if (route == null) return;
    // Not this gateway's turn (one the user ran in the app): what waited on
    // it starts now.
    if (!route.busy) {
      this.startQueued(route);
      return;
    }
    if (record.kind === "stopped") {
      // What a stopped turn had not said yet stays unsaid.
      route.buffer = "";
      route.taggedReply = null;
      this.finishTurn(route);
      return;
    }
    this.flushReply(route);
    const failure = chatFailureOf(record, route.delivered);
    if (failure != null) {
      console.log(
        `[messaging] ${route.platform}:${route.chatId} turn ended ${record.kind}` +
          (record.cause != null ? ` (${record.cause})` : "") +
          (record.error?.message != null ? `: ${record.error.message}` : "")
      );
      this.startFailureReply(route, failure);
    }
    this.finishTurn(route);
  }

  /**
   * A long turn in the user's own chat hears where it stands: the model's
   * latest update line at most once every PROGRESS_LINE_EVERY_MS, and the
   * still-working note, naming what it is doing, only when nothing went out
   * for PROGRESS_NOTE_EVERY_MS. Never in a contact's chat, which only ever
   * hears the reply. Each is said once, as it is due: it is not the reply,
   * never kept to retry, and never counts as the turn having answered.
   */
  private watchProgress(route: Route): void {
    this.stopWatchingProgress(route);
    if (!route.owner) return;
    route.progress = { heardAt: route.busySince, line: null, tool: null };
    route.progressTimer = setInterval(() => {
      if (!route.busy || this.routesBySession.get(route.sessionId) !== route) {
        this.stopWatchingProgress(route);
        return;
      }
      this.tickProgress(route);
    }, PROGRESS_CHECK_MS);
    route.progressTimer.unref?.();
  }

  private stopWatchingProgress(route: Route): void {
    if (route.progressTimer != null) clearInterval(route.progressTimer);
    route.progressTimer = null;
    route.progress = null;
  }

  /** Sends the pending update line, or the fallback note, if one is due. */
  private tickProgress(route: Route): void {
    const progress = route.progress;
    if (progress == null) return;
    const now = Date.now();
    const quiet = now - progress.heardAt;
    if (progress.line != null && quiet >= PROGRESS_LINE_EVERY_MS) {
      const line = progress.line;
      progress.line = null;
      progress.heardAt = now;
      void this.sayProgress(route, forChat(line, route.platform));
    } else if (quiet >= PROGRESS_NOTE_EVERY_MS) {
      progress.heardAt = now;
      const minutes = Math.round((now - route.busySince) / 60_000);
      void this.sayStillWorking(route, minutes, progress.tool);
    }
  }

  private async sayStillWorking(
    route: Route,
    minutes: number,
    tool: string | null
  ): Promise<void> {
    const words = await channelWords(
      channelLocale(
        readUserLanguage()?.name ?? null,
        this.options.appLanguage?.() ?? null
      )
    );
    const activity = tool != null ? toolActivity(tool) : null;
    await this.sayProgress(
      route,
      forChat(
        activity != null
          ? words.t("outcome.channel.stillWorkingOn", {
              minutes,
              activity: words.t(`chat.busy.activity.${activity}`),
            })
          : words.t("outcome.channel.stillWorking", { minutes }),
        route.platform
      )
    );
  }

  /** Runs `send` after the route's send still going, retries included, so the chat reads them in order. */
  private inRouteOrder(route: Route, send: () => Promise<void>): Promise<void> {
    const sending = route.sending == null ? send() : route.sending.then(send);
    route.sending = sending;
    void sending.finally(() => {
      if (route.sending === sending) route.sending = null;
    });
    return sending;
  }

  /** In the route's order, so it never overtakes an answer still sending. */
  private sayProgress(route: Route, text: string): Promise<void> {
    return this.inRouteOrder(route, () => this.sendProgress(route, text));
  }

  private async sendProgress(route: Route, text: string): Promise<void> {
    const connector = this.connectors.get(route.platform);
    if (!route.busy || connector == null) return;
    try {
      await connector.sendText(route.chatId, text, route.replyContext);
      this.appendLog({
        platform: route.platform,
        chatId: route.chatId,
        userId: "me",
        userName: null,
        text,
        direction: "out",
        at: new Date().toISOString(),
      });
    } catch (error) {
      console.error(
        `[messaging] ${route.platform}:${route.chatId} progress note failed:`,
        error
      );
    }
  }

  /** Free the route once any failure line has gone; start what queued. */
  private finishTurn(route: Route): void {
    if (!route.busy) return;

    // A failed turn's line is still on its way; the turn ends once it has gone.
    if (route.failureReply != null) {
      void route.failureReply.then(() => this.finishTurn(route));
      return;
    }

    route.busy = false;
    route.appJoined = false;
    route.answerContexts.clear();
    this.stopWatchingProgress(route);
    this.chatTurnEndedAt.set(
      route.sessionId,
      this.options.now?.() ?? Date.now()
    );
    this.startQueued(route);
  }

  /**
   * A free account crossed a credit milestone right after a chat-app turn in
   * `sessionId`: one line in the user's own chat on that app, never in a
   * contact's. Whether it went; false when the turn was not a chat app's.
   */
  tellCreditThreshold(
    sessionId: string,
    mark: CreditThresholdMark
  ): Promise<boolean> {
    return this.tellOwnChat(sessionId, (words, link, billing) =>
      chatLineForCreditThreshold(words, mark, link, billing)
    );
  }

  /**
   * Routines are waiting for credits: one line in the user's own chat, on
   * the first app linked. No turn to answer, so no route is needed. Whether
   * it went; false with no chat app linked.
   */
  async tellRoutinesOnHold(): Promise<boolean> {
    const own = [...this.connectors.keys()]
      .map((platform) => this.selfChatOf(platform))
      .find((chat) => chat != null);
    if (own == null) return false;
    this.deliverToSelf(own, await this.accountLine(chatLineForRoutinesOnHold));
    return true;
  }

  /**
   * The success pitch, once ever, in the user's own chat on the app whose
   * turn in `sessionId` just ended. Whether it went.
   */
  tellSuccessPitch(sessionId: string): Promise<boolean> {
    return this.tellOwnChat(sessionId, chatLineForSuccessPitch);
  }

  /**
   * A line about the account, said in the user's own chat on the app whose
   * turn in `sessionId` just ended (never a contact's), in their language,
   * with the plan as just read and its upgrade link. False when the turn was
   * not a chat app's, or long over.
   */
  private async tellOwnChat(
    sessionId: string,
    line: (
      words: ChannelWords,
      link: string,
      billing: BillingPlan | null
    ) => string | null
  ): Promise<boolean> {
    const route = this.routesBySession.get(sessionId);
    const ended = this.chatTurnEndedAt.get(sessionId);
    const now = this.options.now?.() ?? Date.now();
    if (route == null || ended == null || now - ended > CHAT_TURN_RECENT_MS)
      return false;
    const own = this.selfChatOf(route.platform);
    if (own == null) return false;
    const isOwn =
      own.platform === route.platform && own.chatId === route.userId;
    const text = await this.accountLine(line);
    // Nothing true to say (a paid plan whose offer is not known): not told.
    if (text == null) return false;
    if (isOwn) this.deliver(route, text);
    else this.deliverToSelf(own, text);
    return true;
  }

  /** A line about the account, in the user's language, with the plan and its link. */
  private async accountLine<Line extends string | null>(
    line: (
      words: ChannelWords,
      link: string,
      billing: BillingPlan | null
    ) => Line
  ): Promise<Line> {
    const [upgradeUrl, billing] = await Promise.all([
      withinMs(fetchUpgradeUrl("channel"), UPGRADE_URL_WAIT_MS),
      withinMs(fetchBillingPlan(false), UPGRADE_URL_WAIT_MS),
    ]);
    const words = await channelWords(
      channelLocale(
        readUserLanguage()?.name ?? null,
        this.options.appLanguage?.() ?? null
      )
    );
    return line(
      words,
      billing?.upgrades[0]?.url ?? upgradeUrl ?? botUpgradePage("channel"),
      billing
    );
  }

  /** Start the next message waiting on the route's session, its own first. */
  private startQueued(route: Route): void {
    const next = route.queue.shift();
    if (next != null) {
      this.dispatch(route, next.text, next.replyContext, next.note === true);
      return;
    }

    // Bot routes share the session: another chat may have queued while this
    // one held the turn, and nothing else will ever start it.
    if (!route.viaBot) return;
    for (const sibling of this.routes.values()) {
      if (sibling.sessionId !== route.sessionId || sibling === route) continue;
      const queued = sibling.queue.shift();
      if (queued != null) {
        this.dispatch(
          sibling,
          queued.text,
          queued.replyContext,
          queued.note === true
        );
        return;
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
        // No retry can deliver it, so nothing is kept to retry either.
        if (error instanceof UndeliverableChatError) {
          console.error(
            `[messaging] ${platformId} send dropped: ${error.message}`
          );
          return;
        }
        lastError = error;
        console.error(
          `[messaging] ${platformId} send failed (will retry):`,
          error
        );
      }
    }
    console.error(
      `[messaging] ${platformId} send to ${chatId} failed after ${delays.length} attempts, kept to retry`
    );
    this.outbox.owe(
      {
        id: randomUUID(),
        platform: platformId,
        chatId,
        text,
        ...(replyContext != null ? { replyContext } : {}),
        userName: this.routes.get(`${platformId}:${chatId}`)?.userName ?? null,
        firstFailedAt: this.options.now?.() ?? Date.now(),
      },
      OUTBOX_RETRY_MS[0] ?? 0
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

  /** The agent answered a chat with its own send: that turn has reached it. */
  private noteAgentSent(platformId: MessagingPlatformId, chatId: string): void {
    const route = this.routes.get(`${platformId}:${chatId}`);
    if (route?.busy === true) route.delivered = true;
  }

  /**
   * A chat turn the app closed under (a quit, an update, a crash), found on
   * the next start. The chat is owed its ending like any other, sent once its
   * platform is up: the user's own chat gets the line, a contact the neutral
   * one, and the user's own chat who went unanswered. Owed synchronously, by
   * the turn's id, so it is on disk before the ledger lets the turn go and a
   * replayed start owes nothing twice.
   */
  private oweInterrupted(record: TurnRecord): void {
    const channel = record.channel;
    if (channel == null) return;
    const platform = channel.platform as MessagingPlatformId;
    const owe = (
      slot: string,
      chatId: string,
      say: OwedLine,
      toSelf = false
    ): void => {
      this.outbox.owe(
        {
          id: `${record.turnId}:${slot}`,
          platform,
          chatId,
          text: "",
          say,
          userName: channel.userName,
          firstFailedAt: this.options.now?.() ?? Date.now(),
          ...(toSelf ? { toSelf: true } : {}),
        },
        OUTBOX_STARTUP_DELAY_MS
      );
    };
    if (channel.owner) owe("chat", channel.chatId, "appClosed");
    else {
      owe("chat", channel.chatId, "contactNeutral");
      owe("owner", "", "contactAppClosed", true);
    }
  }

  /** One later attempt at a message still owed; true once it went. */
  private async sendOwed(message: OwedMessage): Promise<boolean> {
    // The user's own chat on the platform, known only once it is up.
    const own =
      message.toSelf === true ? this.selfChatOf(message.platform) : null;
    if (message.toSelf === true && own == null) return false;
    const platform = own?.platform ?? message.platform;
    const chatId = own?.chatId ?? message.chatId;
    const connector = this.connectors.get(platform);
    if (connector == null) return false;
    const text =
      message.say != null
        ? forChat(await this.wordOwed(message.say, message.userName), platform)
        : message.text;
    const send = () => connector.sendText(chatId, text, message.replyContext);
    // The user's own chat may have a route sending an answer: this waits for
    // it, so the chat reads them in order.
    const route = own != null ? this.routes.get(`${platform}:${chatId}`) : null;
    if (route != null) await this.inRouteOrder(route, send);
    else await send();
    this.appendLog({
      platform,
      chatId,
      userId: "me",
      userName: null,
      text,
      direction: "out",
      at: new Date(this.options.now?.() ?? Date.now()).toISOString(),
    });
    return true;
  }

  /** An owed line in the user's language as of now. */
  private async wordOwed(
    say: OwedLine,
    userName: string | null
  ): Promise<string> {
    const words = await channelWords(
      channelLocale(
        readUserLanguage()?.name ?? null,
        this.options.appLanguage?.() ?? null
      )
    );
    switch (say) {
      case "appClosed":
        return words.t("outcome.channel.appClosed");
      case "contactNeutral":
        return words.t("outcome.channel.contactNeutral");
      case "contactAppClosed":
        return contactFailureNotice(
          words,
          userName,
          words.t("outcome.channel.appClosed")
        );
    }
  }

  /** A link that ended can't say so in its own chat, so the computer does. */
  private async tellLinkLost(platformId: MessagingPlatformId): Promise<void> {
    if (this.linkLossTold.has(platformId)) return;
    this.linkLossTold.add(platformId);
    const words = await channelWords(
      channelLocale(
        readUserLanguage()?.name ?? null,
        this.options.appLanguage?.() ?? null
      )
    );
    const platform = words.t(
      `messaging.platforms.${messagingPlatformSpec(platformId)?.nameKey ?? platformId}`
    );
    this.options.notifyUser?.(
      platformId,
      words.t("native.linkLostTitle", { platform }),
      words.t("native.linkLostLane", { platform }),
      `link-lost:${platformId}`
    );
    this.tellInAnotherApp(
      platformId,
      words.t("native.linkLostLane", { platform })
    );
  }

  /** The down app's own chat can't carry a notice about it; another connected app's can. */
  private tellInAnotherApp(
    platformId: MessagingPlatformId,
    text: string
  ): void {
    const other = [...this.connectors.keys()]
      .filter(
        (id) => id !== platformId && this.states.get(id)?.state === "connected"
      )
      .map((id) => this.selfChatOf(id))
      .find((chat) => chat != null && chat.platform !== platformId);
    if (other != null) this.deliverToSelf(other, text);
  }

  /** Retrying stopped on a failure only the user can clear: OS notification and another app's chat. */
  private async tellLaneBlocked(
    platformId: MessagingPlatformId
  ): Promise<void> {
    const words = await channelWords(
      channelLocale(
        readUserLanguage()?.name ?? null,
        this.options.appLanguage?.() ?? null
      )
    );
    const platform = words.t(
      `messaging.platforms.${messagingPlatformSpec(platformId)?.nameKey ?? platformId}`
    );
    const body = words.t("native.laneBlockedBody", { platform });
    this.options.notifyUser?.(
      platformId,
      words.t("native.laneDownTitle", { platform }),
      body,
      `link-lost:${platformId}`
    );
    this.tellInAnotherApp(platformId, body);
  }

  /** A lane down for an hour, still retrying: one OS notification per outage. */
  private async tellLaneDown(platformId: MessagingPlatformId): Promise<void> {
    const words = await channelWords(
      channelLocale(
        readUserLanguage()?.name ?? null,
        this.options.appLanguage?.() ?? null
      )
    );
    const platform = words.t(
      `messaging.platforms.${messagingPlatformSpec(platformId)?.nameKey ?? platformId}`
    );
    this.options.notifyUser?.(
      platformId,
      words.t("native.laneDownTitle", { platform }),
      words.t("native.laneDownBody", { platform }),
      `link-lost:${platformId}`
    );
  }

  /** The user's own chat hears which message never went, unless it was theirs. */
  private async tellUndelivered(entry: OwedMessage): Promise<void> {
    console.error(
      `[messaging] ${entry.platform} message to ${entry.chatId} given up on`
    );
    const own = this.selfChatOf(entry.platform);
    if (
      own == null ||
      entry.toSelf === true ||
      (own.platform === entry.platform && own.chatId === entry.chatId)
    )
      return;
    const words = await channelWords(
      channelLocale(
        readUserLanguage()?.name ?? null,
        this.options.appLanguage?.() ?? null
      )
    );
    const name =
      entry.userName != null && entry.userName.trim().length > 0
        ? entry.userName.trim()
        : words.t("outcome.channel.someone");
    this.deliverToSelf(own, words.t("outcome.channel.undelivered", { name }));
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

  /**
   * Shared-bot platforms: open a link page in an app-owned window. Discord's
   * open in the app's Discord window when there is one (see
   * DiscordWebConnector.present), where the consent page's answer is caught
   * and linked.
   */
  async openSharedChannelLink(
    platformId: MessagingPlatformId,
    target: SharedLinkTarget = "install"
  ): Promise<void | string> {
    const connector = this.connectors.get(platformId);
    if (!(connector instanceof AbacusChannelsConnector)) return;
    const session = this.discordSessionFor(platformId);
    if (session == null) return connector.openLink(target);
    const url = connector.linkUrl(target);
    const capture =
      target === "authorize"
        ? (connector.consentRedirectUri() ?? undefined)
        : undefined;
    // Not awaited: the page waits on the user, and the snapshot carries the link.
    void session
      .present(url, capture)
      .then(async (callback) => {
        if (callback == null) return;
        await connector.completeAuthorize(callback);
        this.options.emitChanged();
      })
      .catch((error: unknown) => {
        console.error(`[messaging] ${platformId}: link page failed:`, error);
      });
  }

  /** The app's Discord window, where the Discord bot's link pages open. */
  private discordSessionFor(
    platformId: MessagingPlatformId
  ): DiscordWebConnector | null {
    if (platformId !== "abacus_discord") return null;
    const session = this.connectors.get("discord");
    return session instanceof DiscordWebConnector ? session : null;
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

  /**
   * Its connect dialog closed without a link: stop showing the login, but
   * leave it running, since a scan already made may still land. Unfinished
   * after RELEASED_LOGIN_MS, the platform is turned off (with its shared-bot
   * lane, as Unlink does).
   */
  releaseLogin(platformId: MessagingPlatformId): void {
    const state = this.states.get(platformId)?.state;
    if (state === "connected" || state === "syncing") return;
    const connector = this.connectors.get(platformId);
    if (
      connector instanceof TelegramWebConnector ||
      connector instanceof DiscordWebConnector ||
      connector instanceof WhatsAppWebConnector
    )
      connector.hideLoginWindow();
    this.armReleasedLogin(platformId);
  }

  private armReleasedLogin(platformId: MessagingPlatformId): void {
    this.clearReleasedLogin(platformId);
    const timer = setTimeout(() => {
      this.releasedLogins.delete(platformId);
      void this.abandonLogin(platformId).catch((err: unknown) => {
        console.error(`[messaging] ${platformId}: turning off failed:`, err);
      });
    }, RELEASED_LOGIN_MS);
    timer.unref?.();
    this.releasedLogins.set(platformId, timer);
  }

  private clearReleasedLogin(platformId: MessagingPlatformId): void {
    const timer = this.releasedLogins.get(platformId);
    if (timer == null) return;
    clearTimeout(timer);
    this.releasedLogins.delete(platformId);
  }

  private async abandonLogin(platformId: MessagingPlatformId): Promise<void> {
    const state = this.states.get(platformId)?.state;
    // Still loading (a stored link signing back in, or a slow page): nobody
    // has been shown a login to finish, so it is asked again later.
    if (state === "connecting") {
      this.armReleasedLogin(platformId);
      return;
    }
    if (state === "connected" || state === "syncing") return;
    console.log(
      `[messaging] ${platformId}: login not finished ${RELEASED_LOGIN_MS / 1000}s after its dialog closed; turning it off`
    );
    const shared = SHARED_BOT_PLATFORM_OF[platformId];
    if (shared != null)
      await this.updatePlatform({ platformId: shared, enabled: false });
    await this.updatePlatform({ platformId, enabled: false });
  }

  /** Bring a web-login platform's sign-in window back to the front. */
  showMessagingLogin(platformId: MessagingPlatformId): void {
    // Shown again: the user is back on it, so nothing is abandoned.
    this.clearReleasedLogin(platformId);
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
  /**
   * Platforms that lost their login and need the user to link them again.
   * Not `connecting`: that is a launch or a blip, and it settles by itself.
   */
  unlinkedPlatforms(): MessagingPlatformId[] {
    return [...this.connectors.keys()].filter(
      (id) => this.states.get(id)?.state === "needs_login"
    );
  }

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
  // Who auto-reply answers: the one rule
  // ---------------------------------------------------------------------------

  /**
   * Answer or hold a message while auto-reply is on. Answered: the user's own
   * chat, and who the user approved (in the app, or by asking a bot). With
   * the private-chats switch on, also anyone known to be writing one to one.
   * Never a group the user did not approve: a reply there reaches everyone.
   */
  private answerDecision(
    platformId: MessagingPlatformId,
    message: InboundMessage,
    isSelf: boolean
  ): "answer" | "hold" | "takeBack" {
    const approved = approvedUserIds(platformId).has(message.userId);
    const row = findPairing(platformId, message.userId);
    if (isSelf) {
      if (approved) return "answer";
      // The identity the connector proved at connect outranks the queue, but
      // not a pause: approving on sight undid it with the next message.
      if (row?.status === "paused") return "hold";
      recordPairingRequest({
        platform: platformId,
        userId: message.userId,
        userName: message.userName,
        chatId: message.chatId,
        firstMessage: message.text,
        kind: "direct",
      });
      approvePairing(platformId, message.userId);
      this.options.emitChanged();
      return "answer";
    }
    if (approved) {
      // The kind is learned as messages arrive, for the lists and the rule below.
      if (message.kind != null && row != null && row.kind !== message.kind)
        recordPairingRequest({
          platform: platformId,
          userId: message.userId,
          userName: message.userName,
          chatId: message.chatId,
          firstMessage: null,
          kind: message.kind,
        });
      return row == null || answersApproved(row) ? "answer" : "takeBack";
    }
    if (row?.status === "paused") return "hold";
    return readGatewaySettings().answerPrivateChats === true &&
      message.kind === "direct"
      ? "answer"
      : "hold";
  }

  /**
   * Recorded for the user's decision and not answered. While auto-reply is
   * on the user hears of each chat once (a mark on its row): when it first
   * writes, or writes again after arriving while auto-reply was off, and when
   * an old automatic approval is taken back (it was answered, and stops).
   */
  private holdSender(
    platformId: MessagingPlatformId,
    message: InboundMessage,
    options: { tell: boolean; takeBack?: boolean }
  ): void {
    // A group is listed and announced by its own name, not by who posted.
    const name =
      message.kind === "group"
        ? (message.chatName ?? message.userName ?? message.userId)
        : (message.userName ?? message.userId);
    const known = findPairing(platformId, message.userId);
    recordPairingRequest({
      platform: platformId,
      userId: message.userId,
      userName: name,
      chatId: message.chatId,
      firstMessage: message.text,
      kind: message.kind,
    });
    const takeBack = options.takeBack === true;
    if (takeBack) {
      console.log(
        `[messaging] ${platformId}: a chat approved without the user wrote in, now waiting for them`
      );
      holdPairing(platformId, message.userId);
      this.dropRoutes(platformId, message.userId, message.chatId);
    }
    const key = `${platformId}:${message.userId}`;
    // The mark lives on the row; the run's own set covers a row the pending
    // cap evicted and a stranger re-created.
    const told = known?.toldAt != null || this.toldThisRun.has(key);
    if (options.tell && (takeBack || !told)) {
      this.toldThisRun.add(key);
      markPairingTold(platformId, message.userId);
      this.queueWaitingNotice({
        platform: platformId,
        userId: message.userId,
        name: known?.userName ?? name,
        why: takeBack
          ? "takenBack"
          : message.kind === "group"
            ? "group"
            : "person",
      });
    }
    this.options.emitChanged();
  }

  /**
   * Notices go out at most once a minute. One waiting chat is named; a burst
   * is one notice that names a few people and counts the groups. What waits
   * for the gap is sent when it ends, not held until the next message.
   */
  private queueWaitingNotice(entry: WaitingNotice): void {
    this.waitingQueue.push(entry);
    if (this.waitingTimer != null) return;
    const now = this.options.now?.() ?? Date.now();
    const wait = this.waitingToldAt + SENDER_NOTICE_GAP_MS - now;
    if (wait <= 0) {
      void this.flushWaitingNotices();
      return;
    }
    this.waitingTimer = setTimeout(() => {
      this.waitingTimer = null;
      void this.flushWaitingNotices();
    }, wait);
    this.waitingTimer.unref?.();
  }

  private dropWaitingNotices(): void {
    if (this.waitingTimer != null) clearTimeout(this.waitingTimer);
    this.waitingTimer = null;
    this.waitingQueue.length = 0;
  }

  private async flushWaitingNotices(): Promise<void> {
    const entries = this.waitingQueue.splice(0);
    const [only] = entries;
    if (only == null) return;
    const now = this.options.now?.() ?? Date.now();
    this.waitingToldAt = now;
    const words = await channelWords(
      channelLocale(
        readUserLanguage()?.name ?? null,
        this.options.appLanguage?.() ?? null
      )
    );
    const platformName = (id: MessagingPlatformId) =>
      words.t(
        `messaging.platforms.${messagingPlatformSpec(id)?.nameKey ?? id}`
      );
    if (entries.length === 1) {
      const platform = platformName(only.platform);
      const [title, body] = {
        person: ["native.senderWaitingTitle", "native.senderWaitingBody"],
        group: ["native.groupWaitingTitle", "native.groupWaitingBody"],
        takenBack: ["native.takenBackTitle", "native.takenBackBody"],
      }[only.why];
      this.options.notifyUser?.(
        only.platform,
        words.t(title, { name: only.name, platform }),
        words.t(body),
        `sender-waiting:${only.platform}:${only.userId}`
      );
      return;
    }
    const people = entries.filter((entry) => entry.why !== "group");
    const groups = entries.length - people.length;
    const names = [
      ...people.slice(0, NOTICE_NAMES).map((entry) => entry.name),
      ...(people.length > NOTICE_NAMES
        ? [
            words.t("native.morePeople", {
              count: people.length - NOTICE_NAMES,
            }),
          ]
        : []),
      ...(groups > 0 ? [words.t("native.groupsCount", { count: groups })] : []),
    ].join(", ");
    this.options.notifyUser?.(
      only.platform,
      words.t("native.chatsWaitingTitle", { count: entries.length }),
      words.t("native.chatsWaitingBody", { names }),
      `senders-waiting:${now}`
    );
  }

  /** A row for the user's own chat: never someone to approve or list. */
  private isOwnRow(row: MessagingPairedUser): boolean {
    return (
      row.userId === SELF_CHAT_ID ||
      this.connectors.get(row.platform)?.selfChatId?.() === row.userId ||
      this.isOwnChat(row.platform, row.chatId)
    );
  }

  /** Everyone auto-reply answers once on: what the switch, the card and the tool show. */
  private answeredRows(): MessagingPairedUser[] {
    return listPairing().filter(
      (row) =>
        row.status === "approved" && answersApproved(row) && !this.isOwnRow(row)
    );
  }

  /** Approved by the old rule, not by the user: answered only once re-approved. */
  private reapproveRows(): MessagingPairedUser[] {
    return listPairing().filter(
      (row) =>
        row.status === "approved" &&
        !answersApproved(row) &&
        !this.isOwnRow(row)
    );
  }

  /**
   * Waiting for the user's decision; old automatic approvals first. With the
   * private-chats switch on, a chat known to be one person is answered, not waiting.
   */
  private waitingRows(): MessagingPairedUser[] {
    const privateAnswered = readGatewaySettings().answerPrivateChats === true;
    const rows = listPairing().filter(
      (row) =>
        row.status === "pending" &&
        !this.isOwnRow(row) &&
        !(privateAnswered && row.kind === "direct")
    );
    return [
      ...rows.filter((row) => row.autoAdded === true),
      ...rows.filter((row) => row.autoAdded !== true),
    ];
  }

  // ---------------------------------------------------------------------------
  // Auto-reply (the bot-only auto_reply tool)
  // ---------------------------------------------------------------------------

  /**
   * The first time a lane proves which chat is the user's own, it gets its
   * default home bot: the bot that asked to connect it, else the template
   * rule of `homeBots.ensure`. A home bot set already (an older install's)
   * is kept. Once ever: the stored flag survives relinks, so a later
   * connect, from whichever bot, never moves it. The global switch and
   * general bot stay untouched: the bootstrap's promise is only the self chat.
   */
  private maybeBootstrapSelfLane(lane: SelfLanePlatform): void {
    const homeBots = this.options.homeBots;
    if (homeBots == null) return;
    if (readGatewaySettings().autoReplyBootstrappedFor.includes(lane)) return;
    // Onboarding's own first bot is the default; it settles on completion.
    if (this.options.deferSelfLaneDefaults?.() === true) return;
    const claimant = this.takeLinkClaim(lane);
    let botId = homeBots.get(lane);
    if (botId == null && claimant != null) {
      try {
        homeBots.set(lane, claimant);
        botId = claimant;
      } catch (error) {
        console.error(`[messaging] ${lane}: claimant bot unusable:`, error);
      }
    }
    botId ??= homeBots.ensure(lane);
    saveGatewaySettings({ autoReplyBootstrappedFor: [lane] });
    if (botId == null) return;
    console.log(`[messaging] ${lane} linked, home bot ${botId}`);
    this.options.emitChanged();
  }

  /** Every linked lane still owed its default; onboarding just finished. */
  settleSelfLaneDefaults(): void {
    for (const [platformId, connector] of this.connectors) {
      const self = connector.selfChatId?.() ?? null;
      if (isSelfLane(platformId) && self != null && self.length > 0)
        this.maybeBootstrapSelfLane(platformId);
    }
  }

  /**
   * A bot asked to connect a chat app (connect_connector in its chat): if
   * that app's lane links soon, the bot is its home bot. Only the default:
   * a lane that has one already ignores it.
   */
  claimSelfLane(platformId: MessagingPlatformId, botId: string): void {
    const lane = selfLaneOf(platformId);
    if (lane == null) return;
    if (readGatewaySettings().autoReplyBootstrappedFor.includes(lane)) return;
    this.linkClaims.set(lane, {
      botId,
      at: this.options.now?.() ?? Date.now(),
    });
  }

  private takeLinkClaim(lane: SelfLanePlatform): string | null {
    const claim = this.linkClaims.get(lane);
    this.linkClaims.delete(lane);
    if (claim == null) return null;
    const now = this.options.now?.() ?? Date.now();
    return now - claim.at <= LINK_CLAIM_MS ? claim.botId : null;
  }

  /** The two settings-pane switches, reachable from inside a bot's chat. */
  enableAutoReply(botId: string): void {
    saveGatewaySettings({ respondToInbound: true, botId });
    this.options.emitChanged();
  }

  /** Stop answering. The pairing list survives; stopping is not forgetting. */
  disableAutoReply(): void {
    // Notices are about chats auto-reply is not answering; off, nothing is owed.
    this.dropWaitingNotices();
    saveGatewaySettings({ respondToInbound: false });
    this.options.emitChanged();
  }

  autoReplyStatus(): {
    respondToInbound: boolean;
    botId: string | null;
    /** Also anyone writing one to one, unapproved. */
    answerPrivateChats: boolean;
    /** Who is answered: the same list the app's switch confirms. */
    approved: Array<{
      platform: MessagingPlatformId;
      userId: string;
      name: string;
      isGroup: boolean;
    }>;
    /** Senders who have messaged in but are not allowed; newest last. */
    pending: Array<{
      platform: MessagingPlatformId;
      userId: string;
      name: string;
      isGroup: boolean;
    }>;
    /** Approved by an older version, not answered until the user approves again. */
    reapprove: Array<{
      platform: MessagingPlatformId;
      userId: string;
      name: string;
      isGroup: boolean;
    }>;
  } {
    const settings = readGatewaySettings();
    const shape = (row: MessagingPairedUser) => ({
      platform: row.platform,
      userId: row.userId,
      name: row.userName ?? row.userId,
      isGroup: row.kind === "group",
    });
    return {
      respondToInbound: settings.respondToInbound,
      botId: settings.botId,
      answerPrivateChats: settings.answerPrivateChats,
      approved: this.answeredRows().map(shape),
      pending: this.waitingRows().map(shape),
      reapprove: this.reapproveRows().map(shape),
    };
  }

  /** "Answer anyone who writes to me one to one", from a bot's chat or the app. */
  setAnswerPrivateChats(on: boolean): void {
    saveGatewaySettings({ answerPrivateChats: on });
    this.options.emitChanged();
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
    if (isSelfName(target)) {
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
    // A known chat id that happens not to look like one (Slack's C… channel
    // ids, say) is an id, not a name to resolve.
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
   * The one way the app's own report reaches the user's own chat on `lane`:
   * kept in the outbox first (an id owed or sent once is never sent again),
   * then sent at once when it can go. Otherwise it waits for the lane, until
   * `notBefore`, never past `expiresAt`, and a later message with the same
   * `replaces` drops it unsent.
   */
  async sendToOwnChat(
    lane: SelfLanePlatform,
    message: {
      id: string;
      text: string;
      notBefore?: number;
      expiresAt?: number;
      replaces?: string;
    }
  ): Promise<"sent" | "queued" | "dropped"> {
    const owed = this.outbox.owe(
      {
        id: message.id,
        platform: lane,
        chatId: "",
        toSelf: true,
        text: forChat(message.text, lane),
        userName: null,
        firstFailedAt: this.options.now?.() ?? Date.now(),
        ...(message.notBefore != null ? { notBefore: message.notBefore } : {}),
        ...(message.expiresAt != null ? { expiresAt: message.expiresAt } : {}),
        ...(message.replaces != null ? { replaces: message.replaces } : {}),
      },
      0
    );
    if (owed) await this.outbox.flush();
    return this.outbox.statusOf(message.id) ?? "dropped";
  }

  /** `to` on `platform` is the user's own chat there. */
  isOwnChat(platform: string, to: string): boolean {
    if (!isMessagingPlatformId(platform)) return false;
    return isOwnChatTarget(to, this.selfChatOf(platform)?.chatId ?? null);
  }

  /**
   * Send on the agent's behalf. Unlike safeSend, a failed delivery must reach
   * the model as an error it can report. No allowlist: the user asking
   * "message so-and-so" from a chat they are driving is the authorization.
   */
  async sendToChat(
    platformId: MessagingPlatformId,
    chatId: string,
    text: string,
    // The sending bot: named on what lands in the user's own chat, unless
    // it is that chat's home bot.
    from?: { botId: string; name: string }
  ): Promise<void> {
    // "me" on a platform with no self chat (Discord: you cannot DM yourself)
    // is still deliverable through the shared Abacus bot's DM.
    if (isSelfName(chatId)) {
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
    // The self chat is the home bot's conversation; another bot's update
    // there says whose it is.
    if (
      from != null &&
      isSelfLane(platformId) &&
      target === connector.selfChatId?.() &&
      this.options.homeBots?.get(platformId) !== from.botId
    )
      text = `[${from.name}] ${text}`;
    text = forChat(text, platformId);
    await connector.sendText(target, text);
    this.noteAgentSent(platformId, target);
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
    this.noteAgentSent(platformId, target);
    this.appendLog({
      platform: platformId,
      chatId: target,
      userId: "me",
      userName: null,
      text: `[sent file: ${modelPath(filePath)}]${caption != null && caption.length > 0 ? ` ${caption}` : ""}`,
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
    if (!(connector instanceof AbacusChannelsConnector)) return undefined;
    const link = connector.sharedLink();
    // One click needs the Discord window to catch the consent page's answer.
    return link.oneClick === true && this.discordSessionFor(platformId) == null
      ? { ...link, oneClick: false }
      : link;
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
    const waiting = this.waitingRows();

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
          recovery:
            enabled && configured && settings.gatewayEnabled
              ? this.supervisor.status(entry.id)
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
          pendingCount: waiting.filter((row) => row.platform === entry.id)
            .length,
          sharedLink: this.sharedLink(entry.id),
          ...(isSelfLane(entry.id)
            ? { homeBotId: this.options.homeBots?.get(entry.id) ?? null }
            : {}),
        };
      }
    );

    return {
      platforms,
      pending: waiting,
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
      answered: this.answeredRows(),
      reapprove: this.reapproveRows(),
      answerPrivateChats: settings.answerPrivateChats,
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
    if (request.enabled != null) {
      // Switched either way by hand: a released login's deadline is moot.
      this.clearReleasedLogin(request.platformId);
      setPlatformEnabled(request.platformId, request.enabled);
    }

    // Credentials changed under a live connector: restart it. `pending_restart`
    // covers the window where stored and in-use values disagree.
    if (request.values != null && this.connectors.has(request.platformId)) {
      await this.stopPlatform(request.platformId);
    }

    await this.syncConnectors();
    return this.getSnapshot();
  }

  /** Try now: restart a lane that is down without waiting for its next try. */
  retryNow(platformId: MessagingPlatformId): MessagingSnapshot {
    this.supervisor.retryNow(platformId);
    return this.getSnapshot();
  }

  /** The Messaging page opened: a lane that is down tries again soon. */
  pageOpened(): void {
    this.supervisor.hint("the Messaging page opened");
  }

  /**
   * The user's Unlink, the only thing that forgets a login: every other way off
   * (a dialog closed unfinished, a stop) keeps it for the next start.
   */
  async unlinkPlatform(
    platformId: MessagingPlatformId
  ): Promise<MessagingSnapshot> {
    const connector = this.connectors.get(platformId);
    if (connector instanceof WhatsAppWebConnector) await connector.logOut();
    await this.updatePlatform({ platformId, enabled: false });
    // The window must be gone before its storage is cleared under it.
    await this.stopPlatform(platformId);
    if (platformId === "whatsapp") await forgetWhatsAppLogin();
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
    answerPrivateChats?: boolean;
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
export const senderLabel = (
  platformId: MessagingPlatformId,
  message: Pick<InboundMessage, "userName" | "userId">
): string =>
  `${platformLabel(platformId)} message from ${
    message.userName ?? message.userId
  }`;

/**
 * How long a failure line waits on the upgrade link: the turn cannot finish
 * until the line has gone, and the plans page is a fine answer too.
 */
const UPGRADE_URL_WAIT_MS = 5_000;

/** A milestone read this soon after a chat-app turn ended belongs to that turn. */
const CHAT_TURN_RECENT_MS = 2 * 60_000;

/** What a call answers, or null when it fails or takes too long. */
const withinMs = <T>(call: Promise<T | null>, ms: number): Promise<T | null> =>
  Promise.race([
    call.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms).unref()),
  ]);

/** Where an account whose free credits are held verifies its phone. */
const ABACUS_VERIFY_PHONE_URL = "https://apps.abacus.ai/bot/link/verify-phone";

/** The signed-in plan as last read; unknown words the offer like a paid one. */
const accountKind = (): AccountKind => {
  const account = cachedAbacusAccount();
  if (account == null) return "unknown";
  return onFreePlan(account) ? "free" : "paid";
};

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

/** The least time between "someone is waiting" notices; a burst folds into one. */
const SENDER_NOTICE_GAP_MS = 60_000;

/** How many people a folded notice names before it counts the rest. */
const NOTICE_NAMES = 3;

/** One chat the user is owed a "waiting" notice about. */
type WaitingNotice = {
  platform: MessagingPlatformId;
  userId: string;
  name: string;
  why: "person" | "group" | "takenBack";
};

/**
 * Whether an approved row is answered: the user's own approvals are; one the
 * old "off approves everyone" rule made is not, until the user approves it again.
 */
const answersApproved = (row: MessagingPairedUser): boolean =>
  row.autoAdded !== true;

const QUEUE_FULL_NOTICE =
  "I'm still working through what you've already sent, so that last one didn't get queued. Send it again once I've replied.";

const NO_WORKSPACE_NOTICE =
  "No workspace is set for messaging yet. Pick one in AbacusAI Bot under Settings → Connectors (messaging settings), then try again.";
