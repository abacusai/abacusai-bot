import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
import { BrowserWindow, net, powerMonitor } from "electron";

import {
  bringToFront,
  dismissOnEscape,
  parentWindow,
  presentAsDialog,
} from "../../bring-to-front";
import {
  backoffDelayMs,
  BOT_SIGNATURE,
  boundedWait,
  chunkMessage,
  looksLikeBotOutput,
  isEphemeralPreview,
  previewMatchesSent,
  normalizeScrapedText,
  type ConnectorCallbacks,
  type MessagingConnector,
  PageLock,
  type PageLockOptions,
  type PageScript,
  pageScript,
  PageStalledError,
  PollScheduler,
  runPageScript,
  setFileInput,
  UndeliverableChatError,
} from "./connector";
import {
  readPlatformSignedIn,
  savePlatformSignedIn,
} from "./messaging-config-service";
import {
  type BridgeChat,
  type BridgeMessage,
  type BridgeRead,
  isConversationJid,
  QueuedSendError,
  resolveJid,
  WhatsAppBridge,
} from "./whatsapp-bridge";

/**
 * WhatsApp, by driving the real web.whatsapp.com in a hidden BrowserWindow
 * with a persisted login partition; WhatsApp's servers reject protocol
 * clients. The brittleness lives in the DOM selectors: the scripts lean on
 * stable hooks (`#pane-side`, `[role="row"]`, `cell-frame-*`, `msg-container`)
 * and judge bubble direction geometrically. The composer is a Lexical editor
 * that ignores synthetic input, so it takes TRUSTED clicks and insertText.
 */

const WHATSAPP_WEB_URL = "https://web.whatsapp.com/";

/** The partition that holds the login. Survives restarts; cleared on disconnect. */
const WHATSAPP_PARTITION = "persist:whatsapp-web";

/**
 * web.whatsapp.com refuses Electron's default UA ("update your browser");
 * present as the Chrome we actually are, without the Electron token.
 */
const userAgent = (): string =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

/** WhatsApp's practical limit is well above this; keep messages readable. */
const MAX_MESSAGE_LENGTH = 4000;
/** Prefix for the bot's messages in the self chat, where they otherwise look
 * like the user's own. Once per message, not per chunk. */
const BOT_LABEL = "*AbacusAI Bot:*";
const withBotLabel = (text: string): string =>
  text.trimStart().startsWith(BOT_LABEL) ? text : `${BOT_LABEL} ${text}`;

/** Every send passes here first: a Status, broadcast list or channel is never
 * a message's destination, however the id reached the send. */
const refuseNonConversation = (chatId: string): void => {
  if (!isConversationJid(chatId))
    throw new UndeliverableChatError(
      `"${chatId}" is a WhatsApp Status, broadcast list or channel, not a chat, so nothing was sent there.`
    );
};

/** How often to check whether the user has finished logging in. */
const LOGIN_POLL_MS = 1500;

/** How often to sweep the chat list for new inbound messages. */
const INBOUND_POLL_MS = 5000;
/** How long a name waits for the chat list after a link before saying WhatsApp is still syncing. */
const CHAT_SYNC_WAIT_MS = 60_000;
/** A user's read, queue wait included. Covers one sweep ahead of it plus a
 * chat-list read (15s each at worst), well inside the agent's tool budget. */
const USER_CALL_DEADLINE_MS = 30_000;
/** A page script past its own waits (30s at most) is a page that stopped answering. */
const SCRIPT_STALL_MS = 60_000;
/** How long a (re)loaded page gets to show the chat list or the QR. */
const PAGE_BOOT_WAIT_MS = 45_000;
/** The same, for a page that was up already (after a wake or a stall). */
const PAGE_SETTLE_MS = 10_000;
const RELOADED = "after WhatsApp Web reloaded";
/** In-place re-attaches before a page that once had the bridge settles for the page driver. */
const RELINK_ATTACH_TRIES = 3;
/** How often the page driver tries the bridge again. */
const BRIDGE_RETRY_MS = 10 * 60_000;
/**
 * Reloads in a row that still show neither the chat list nor the QR before the
 * lane waits on the user. Unbounded, a page that never came back (blocked
 * network, a wedged boot) reloaded every couple of minutes for days.
 */
const MAX_STUCK_RELOADS = 3;
/** QR polls in a row before the page is believed signed out (as after a link). */
const QR_BELIEVED_POLLS = 4;
/** How often a lane parked offline checks whether the network is back. */
const ONLINE_CHECK_MS = 10_000;

/** Chromium's net error for a navigation we replaced or refused ourselves. */
const NET_ERR_ABORTED = -3;
/** Chromium's certificate errors: -200 to -299. */
const isCertError = (code: number): boolean => code <= -200 && code > -300;

const NOT_LINKED =
  "WhatsApp is not linked. Click Connect, then scan the QR from your phone (Settings → Linked devices).";
const STUCK_LOADING =
  "WhatsApp Web did not finish loading. Click Connect to try again.";
const UNREACHABLE =
  "WhatsApp Web could not be reached. Check your connection, then click Connect.";
const CERT_BLOCKED =
  "WhatsApp Web's secure connection failed, so it may be blocked on this network. Click Connect to try again.";

/**
 * Whether the page can be used right now. `reconnecting`: the bridge or the
 * page was lost (sleep, reload, a stall) and one relink is under way;
 * `needs_relink`: the phone unlinked this device; `offline`: no network.
 */
type LinkState = "connected" | "reconnecting" | "needs_relink" | "offline";
type RelinkOutcome =
  | "connected"
  | "retry"
  | "needs_relink"
  | "offline"
  | "stuck";

type LoginState = { loggedIn: boolean; loginVisible?: boolean };

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class WhatsAppWebConnector implements MessagingConnector {
  readonly id: MessagingPlatformId = "whatsapp";

  private window: BrowserWindow | null = null;
  private running = false;
  private loggedIn = false;
  /** Consecutive signed-out polls after a login. See checkLogin. */
  private signedOutTicks = 0;
  /** The self lookup runs once per link; see findSelf. */
  private selfLookupDone = false;
  /** Whether this link has told the gateway which chat is the user's own. */
  private selfLinkedAnnounced = false;
  /** Consecutive QR polls before a link; see QR_BELIEVED_POLLS. */
  private qrTicks = 0;
  /** Stuck-page reloads since the page last showed the chat list or the QR. */
  private stuckReloads = 0;
  /** What the last load since a reload failed on, for the parked note. */
  private loadFailure: "cert" | "network" | null = null;
  /**
   * No page and no checks until the user clicks Connect (resume): signed out
   * last time, out of reloads, or the page could not load at all. The note
   * is what the pane shows and what a call fails with.
   */
  private parkedNote: string | null = null;
  /** The stored sign-in verdict, so a poll writes it on change only. */
  private signedInRecord: boolean | null = null;
  /** Set while a lane parked offline waits to try once more on reconnect. */
  private onlineCheck: ReturnType<typeof setInterval> | null = null;
  private readonly loginPoll = new PollScheduler(
    () => this.checkLogin(),
    LOGIN_POLL_MS,
    (error) => this.logFailure("login check", error)
  );
  private readonly inboundPoll = new PollScheduler(
    () => this.sweepInbound(),
    INBOUND_POLL_MS,
    (error) => this.logFailure("inbound sweep", error)
  );
  private contacts: Array<{ chatId: string; name: string; isGroup?: boolean }> =
    [];
  /** The account's own number ("+digits"): what "me" resolves to. */
  private self: string | null = null;
  /** The self chat's display title, for the inbound sweep's always-watch. */
  private selfDisplayName: string | null = null;
  /** Digits of the chat the /send?phone= route last opened, if still open. */
  private lastNumberOpened: string | null = null;
  /** Chat id -> the last inbound message id we already reported, for dedupe. */
  private lastSeen = new Map<string, string>();
  /** Chat id -> recent texts we sent there, so the sweep skips our own echoes. */
  private lastSentTexts = new Map<string, string[]>();

  // The bridge (whatsapp-bridge.ts) is WhatsApp's own store; when attached,
  // everything goes through it. Otherwise the page driver takes over, but a
  // send is never REPORTED delivered on its say-so alone.
  private bridge: WhatsAppBridge | null = null;
  private bridgeReady = false;
  /** The account's WhatsApp id, from the bridge. */
  private selfJid: string | null = null;
  /** The account's lid, from the bridge, once WhatsApp has assigned one:
   * newer builds file the own chat (and every other) under it. */
  private selfLid: string | null = null;
  /** The own chat's id when it differs from the phone jid: the lid. */
  private ownChatJid: string | null = null;
  /** "Own chat not found" is said once per link, not per chat-list read. */
  private ownChatMissLogged = false;
  /** The page's answers on whether a chat is the user's own, per jid. */
  private ownChatVerdicts = new Map<string, boolean>();
  /** The chat list as the bridge last saw it; names resolve against it. */
  private bridgeChats: BridgeChat[] = [];
  /** WhatsApp has answered the chat list at least once since the bridge attached. */
  private chatListRead = false;
  /** Message ids this session sent: the exact echo guard, when the bridge is on. */
  private sentIds = new Set<string>();
  /** chat+text -> the id of a send WhatsApp queued but never acked; a retry
   * checks that id first so a late delivery is not sent twice. */
  private queuedSends = new Map<string, string>();
  private sweepCount = 0;

  /** The last few outbound texts per chat: every chunk of a multi-chunk
   * reply needs guarding, or the earlier ones echo back in as inbound. */
  private rememberSent(chatId: string, text: string): void {
    const ring = this.lastSentTexts.get(chatId) ?? [];
    ring.push(text);
    if (ring.length > 5) ring.shift();
    this.lastSentTexts.set(chatId, ring);
  }
  /** See PageLock. Only the outermost call takes it. */
  private readonly lock = new PageLock();

  private serialize<T>(
    task: () => Promise<T>,
    options?: PageLockOptions
  ): Promise<T> {
    return this.lock.run(task, options);
  }

  // The connection lifecycle: relink() is the one way back from a lost page
  // or bridge; every call and sweep reads `link`.
  private link: LinkState = "connected";
  /** Why the link is down, for the error a call gets ("after …"). */
  private linkCause = "";
  /** The pane was told the link is down; it hears when it is back. */
  private linkReported = false;
  /** The relink attempt in flight, single-flight. */
  private relinking: Promise<void> | null = null;
  private relinkTimer: NodeJS.Timeout | null = null;
  private relinkAttempts = 0;
  /** The bridge attached on this link and has not been given up on. */
  private bridgeExpected = false;
  private lastAttachTry = 0;
  private asleep = false;
  private stopPowerWatch: (() => void) | null = null;
  /** See USER_CALL_DEADLINE_MS; a field so a test can shorten it. */
  private userDeadlineMs = USER_CALL_DEADLINE_MS;

  private firstInboundSweep = true;
  /** The pane-structure diagnostic runs once per connect. */
  private paneShapeLogged = false;

  constructor(private readonly callbacks: ConnectorCallbacks) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.parkedNote = null;
    this.stuckReloads = 0;
    this.qrTicks = 0;
    this.signedInRecord = readPlatformSignedIn(this.id);
    this.bridge = new WhatsAppBridge({
      run: (script, args) => this.run(script, args),
      raw: async (code) => {
        const win = this.ensureWindow();
        if (win == null || win.isDestroyed()) throw new Error("no page");
        await win.webContents.executeJavaScript(code, true);
      },
      log: (line) => this.callbacks.onLog(line),
    });
    this.watchPower();

    // Signed out last time: a hidden QR has nobody to scan it, so no page is
    // loaded until the user clicks Connect. Never recorded (an install from
    // before the record) loads as it always did.
    if (this.signedInRecord === false) {
      this.callbacks.onLog("whatsapp-web: not linked, waiting for the user");
      this.park("needs_login", NOT_LINKED);
      return;
    }

    this.callbacks.onState("connecting");
    // Hidden: launching the app must never throw WhatsApp Web in the user's
    // face. The connect dialog reveals it when a login screen is on it.
    this.window = this.buildWindow(false);
    try {
      await this.window.loadURL(WHATSAPP_WEB_URL, { userAgent: userAgent() });
    } catch (error) {
      this.callbacks.onLog(
        `whatsapp-web: initial load failed: ${String((error as Error)?.message ?? error)}`
      );
    }

    // A load that failed outright parked the lane (see onLoadFailed).
    if (!this.running || this.parkedNote != null) return;
    this.pollLogin();
    void this.checkLogin();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.parkedNote = null;
    this.stopOnlineCheck();
    this.loggedIn = false;
    this.bridgeReady = false;
    this.bridge = null;
    this.loginPoll.stop();
    this.inboundPoll.stop();
    this.stopPowerWatch?.();
    this.stopPowerWatch = null;
    if (this.relinkTimer != null) clearTimeout(this.relinkTimer);
    this.relinkTimer = null;
    const win = this.window;
    this.window = null;
    if (win != null && !win.isDestroyed()) win.destroy();
    this.callbacks.onState("disabled");
  }

  async sendText(chatId: string, text: string): Promise<void> {
    refuseNonConversation(chatId);
    return this.userCall(() => this.sendTextNow(chatId, text), "send");
  }

  // ── Connection lifecycle ───────────────────────────────────────────────

  /** Sleep pauses the polls; waking checks the page and bridge once. */
  private watchPower(): void {
    const onSuspend = (): void => {
      this.asleep = true;
      this.loginPoll.pause();
      this.inboundPoll.pause();
      if (this.relinkTimer != null) clearTimeout(this.relinkTimer);
      this.relinkTimer = null;
    };
    const onWake = (): void => {
      if (!this.running) return;
      this.asleep = false;
      this.loginPoll.resume();
      if (!this.loggedIn) return;
      this.linkCause = "after the computer woke up";
      this.relink(this.linkCause);
    };
    powerMonitor.on("suspend", onSuspend);
    powerMonitor.on("resume", onWake);
    powerMonitor.on("unlock-screen", onWake);
    this.stopPowerWatch = () => {
      powerMonitor.removeListener("suspend", onSuspend);
      powerMonitor.removeListener("resume", onWake);
      powerMonitor.removeListener("unlock-screen", onWake);
    };
  }

  /**
   * Get the page and bridge back: one attempt at a time, the next on a
   * bounded backoff, the polls paused meanwhile. Never per sweep.
   */
  private relink(cause: string): void {
    if (
      !this.running ||
      !this.loggedIn ||
      this.parkedNote != null ||
      this.link === "needs_relink"
    )
      return;
    if (this.link === "connected") {
      this.link = "reconnecting";
      this.linkCause = cause;
      this.relinkAttempts = 0;
      this.inboundPoll.pause();
      this.callbacks.onLog(`whatsapp-web: reconnecting ${cause}`);
    }
    if (this.relinking != null || this.asleep) return;
    if (this.relinkTimer != null) clearTimeout(this.relinkTimer);
    this.relinkTimer = null;
    this.relinking = this.serialize(() => this.relinkOnce(), { user: true })
      .catch((error: unknown): RelinkOutcome => {
        this.logFailure("reconnect", error);
        return "retry";
      })
      .then((outcome) => {
        this.relinking = null;
        this.settleRelink(outcome);
      });
  }

  /** One try: wait out a booting page, reload one that stays blank or lost
   * the bridge again, then attach. A page still blank after a few reloads
   * waits on the user: one that never loads would reload for good. */
  private async relinkOnce(): Promise<RelinkOutcome> {
    if (!this.running || !this.loggedIn) return "connected";
    this.relinkAttempts += 1;
    if (!net.isOnline()) return "offline";
    let page = await this.waitForPage(
      this.linkCause === RELOADED ? PAGE_BOOT_WAIT_MS : PAGE_SETTLE_MS
    );
    if (page === "blank" || (this.relinkAttempts > 1 && this.bridgeExpected)) {
      if (page === "blank") {
        if (this.stuckReloads >= MAX_STUCK_RELOADS) return "stuck";
        this.stuckReloads += 1;
      }
      await this.reloadPage();
      page = await this.waitForPage(PAGE_BOOT_WAIT_MS);
    }
    // The chat list or the QR: the page works, so its reloads start over.
    if (page !== "blank") this.stuckReloads = 0;
    if (page === "login") return "needs_relink";
    if (page === "blank") return "retry";
    if (!this.bridgeExpected) return "connected";
    if (await this.ensureBridge()) return "connected";
    if (this.relinkAttempts < RELINK_ATTACH_TRIES) return "retry";
    // The page itself is fine: the page driver carries on, as on a build
    // the library never fit.
    this.bridgeExpected = false;
    this.callbacks.onLog(
      "whatsapp-web: the bridge did not come back; using the page driver"
    );
    return "connected";
  }

  private settleRelink(outcome: RelinkOutcome): void {
    if (!this.running || !this.loggedIn || this.link === "connected") return;
    if (outcome === "connected") {
      this.link = "connected";
      this.relinkAttempts = 0;
      this.callbacks.onLog("whatsapp-web: reconnected");
      if (this.linkReported) this.callbacks.onState("connected");
      this.linkReported = false;
      if (!this.asleep) this.inboundPoll.resume();
      return;
    }
    if (outcome === "needs_relink") {
      this.unlinked();
      return;
    }
    if (outcome === "stuck") {
      this.callbacks.onLog(
        `whatsapp-web: still blank after ${MAX_STUCK_RELOADS} reloads, waiting for the user`
      );
      this.parkUnloaded(STUCK_LOADING);
      return;
    }
    this.link = outcome === "offline" ? "offline" : "reconnecting";
    this.linkReported = true;
    this.callbacks.onState("connecting", this.linkMessage());
    if (this.asleep) return;
    this.relinkTimer = setTimeout(() => {
      this.relinkTimer = null;
      this.relink(this.linkCause);
    }, backoffDelayMs(this.relinkAttempts));
  }

  /** What the page settles on: the chat list, the QR, or still nothing. */
  private async waitForPage(ms: number): Promise<"linked" | "login" | "blank"> {
    const deadline = Date.now() + ms;
    let qr = 0;
    while (Date.now() < deadline) {
      const state = await this.run<LoginState>(LOGIN_STATE_SCRIPT, {});
      if (state?.loggedIn === true) return "linked";
      qr = state?.loginVisible === true ? qr + 1 : 0;
      if (qr >= 3) return "login";
      await delay(1000);
    }
    return "blank";
  }

  /** In place, never a new window: see sendTextNow. */
  private async reloadPage(): Promise<void> {
    const win = this.ensureWindow();
    if (win == null || win.isDestroyed()) return;
    this.callbacks.onLog("whatsapp-web: reloading WhatsApp Web to reconnect");
    this.lastNumberOpened = null;
    this.loadFailure = null;
    await boundedWait(
      win.loadURL(WHATSAPP_WEB_URL, { userAgent: userAgent() }),
      PAGE_BOOT_WAIT_MS
    ).catch(() => {});
  }

  /** The error a call gets while the link is down: what, and what to do. */
  private linkMessage(): string {
    if (this.link === "needs_relink")
      return "WhatsApp needs to be linked again: open Library → Messaging and scan the QR code with the phone.";
    if (this.link === "offline")
      return "This computer is offline, so WhatsApp cannot be reached. It reconnects by itself once the network is back.";
    return `WhatsApp is reconnecting ${this.linkCause}. Try again in a moment; nothing needs to be done.`;
  }

  /**
   * A user's call: waits for a relink already under way, else fails at once
   * on a link that is down, then goes ahead of background sweeps. A read is
   * cut short at the deadline, which also ends its page calls; a send never
   * is, since one stopped halfway can still land.
   */
  private async userCall<T>(
    work: () => Promise<T>,
    kind: "read" | "send" = "read"
  ): Promise<T> {
    const deadline = Date.now() + this.userDeadlineMs;
    // Parked: no page until the user's Connect, so the call fails at once.
    if (this.parkedNote != null)
      throw new Error(`${this.parkedNote} Connect is in Library → Messaging.`);
    if (this.relinking != null)
      await boundedWait(this.relinking, this.userDeadlineMs).catch(() => {});
    if (this.link !== "connected") throw new Error(this.linkMessage());
    if (kind === "send") return this.serialize(work, { user: true });
    return this.serialize(work, {
      user: true,
      deadlineMs: Math.max(0, deadline - Date.now()),
      interruptible: true,
      timeoutError: () =>
        new Error(
          this.link !== "connected"
            ? this.linkMessage()
            : !this.contactsReady()
              ? "WhatsApp is still syncing your chats after linking. Try again in a minute."
              : `WhatsApp did not answer within ${this.userDeadlineMs / 1000}s. Try again in a moment.`
        ),
    });
  }

  /** The bridge for this call, if the lifecycle has it: one cheap liveness
   * check, never an attach wait. A bridge found gone starts a relink. */
  private async useBridge(): Promise<boolean> {
    if (this.bridge == null || !this.bridgeReady) return false;
    if (await this.bridge.isLive()) return true;
    this.bridgeReady = false;
    this.relink("after the store bridge detached");
    throw new Error(this.linkMessage());
  }

  private logFailure(what: string, error: unknown): void {
    this.callbacks.onLog(
      `whatsapp-web: ${what} failed: ${String((error as Error)?.message ?? error)}`
    );
  }

  private async sendTextNow(chatId: string, text: string): Promise<void> {
    if (!this.loggedIn)
      throw new Error(
        "WhatsApp is not linked yet. Scan the QR in the login window first."
      );

    // Remembered BEFORE the send: the bridge queues our own message as inbound
    // the moment it is added, and the ack can arrive after the next sweep.
    // Self-chat chunks carry the signature so another AbacusBot on the same
    // phone knows them for ours; the label does the same for the user.
    const toSelf = this.self != null && chatId === this.self;
    const labelled = toSelf ? withBotLabel(text) : text;
    const chunks = chunkMessage(labelled, MAX_MESSAGE_LENGTH).map((chunk) =>
      toSelf ? `${chunk}${BOT_SIGNATURE}` : chunk
    );

    if (await this.useBridge()) {
      for (const chunk of chunks) {
        this.rememberSent(chatId, chunk);
        await this.sendViaBridge(chatId, chunk);
      }
      return;
    }

    for (const chunk of chunks) {
      this.rememberSent(chatId, chunk);
      // Baseline for the heal's read-back, or a common word ("ok") the chat
      // has said before reads as "already delivered".
      const priorMatches = await this.matchingOutCount(chatId, chunk);
      try {
        await this.sendChunk(chatId, chunk);
      } catch (error) {
        // WhatsApp's editor goes stale after sitting open a while and fails
        // every send until something reloads the page. Both stale modes get
        // the same cure: reload, then READ before any resend.
        const message = String((error as Error)?.message ?? error);
        const heldText = message.includes("typed but did not send");
        const vanished = message.includes("could not see it in the chat");
        if (!heldText && !vanished) throw error;
        this.callbacks.onLog(
          "whatsapp-web: the page went stale mid-send; reloading it and verifying before any resend"
        );
        this.lastNumberOpened = null;
        // Reload IN PLACE, never recreate the window: a renderer killed
        // mid-write can corrupt the session store and get the device unlinked.
        const win = this.ensureWindow();
        if (win != null && !win.isDestroyed()) {
          await win
            .loadURL(WHATSAPP_WEB_URL, { userAgent: userAgent() })
            .catch(() => {});
          await delay(3_000);
        }
        // Even a held composer is verified: the cleared-check can misread one
        // whose Enter did send, and a duplicate in a group is not cheap.
        const opened = await this.openChat(chatId);
        if (opened.ok) {
          const check = await this.run<{ found: boolean }>(RECENT_OUT_SCRIPT, {
            head: chunk
              .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
              .slice(0, 48),
            priorMatches,
          });
          if (check?.found === true) {
            this.callbacks.onLog(
              "whatsapp-web: the send had landed after all, not resending"
            );
            continue;
          }
        }
        this.callbacks.onLog(
          "whatsapp-web: verified absent after the heal, resending"
        );
        await this.sendChunk(chatId, chunk);
      }
    }
  }

  /** Attach the bridge, waiting for it: on a link and in a relink only. */
  private async ensureBridge(): Promise<boolean> {
    if (this.bridge == null) return false;
    const ready = await this.bridge.ensure();
    if (ready) this.bridgeExpected = true;
    if (ready && !this.bridgeReady) {
      this.bridgeReady = true;
      // Identity before the chat list: on a fresh link the list is minutes
      // behind history sync, and waiting on it here keeps "me" unknown.
      if (this.selfLookupDone) await this.refreshBridgeChats();
    }
    if (!ready) this.bridgeReady = false;
    return ready;
  }

  /** See MessagingConnector.contactsReady: the chat list has been read, by the bridge or the page. */
  contactsReady(): boolean {
    return this.chatListRead || this.contacts.length > 0;
  }

  /** Read the chat list until WhatsApp answers, boundedly; past the bound, say it is still syncing. */
  private async waitForChatList(chatId: string): Promise<void> {
    const deadline = Date.now() + CHAT_SYNC_WAIT_MS;
    while (!this.contactsReady() && Date.now() < deadline) {
      if (this.bridge != null) await this.refreshBridgeChats();
      if (!this.contactsReady()) await delay(1000);
    }
    if (!this.contactsReady())
      throw new Error(
        `WhatsApp is still syncing your chats after linking, so "${chatId}" cannot be looked up yet. ` +
          "Try again in a minute, or send to a phone number in international format."
      );
  }

  private async refreshBridgeChats(): Promise<void> {
    if (this.bridge == null) return;
    const chats = await this.bridge.listChats();
    if (chats == null) return;
    this.chatListRead = true;
    if (chats.length === 0) return;
    this.bridgeChats = chats;
    // WhatsApp may assign the lid after the link; until it is known, a list
    // filed under lids has no row that reads as the own chat.
    if (this.selfLid == null && this.selfJid != null)
      this.selfLid = (await this.bridge.myId())?.lid ?? null;
    // The whole list, so it replaces the page scrape. The self chat is left
    // out here and added by listContacts; its title names the sweep's sender.
    const own =
      chats.find((chat) => chat.isMe) ??
      chats.find((chat) => this.isOwnChat(chat.jid));
    if (own != null) this.selfDisplayName = own.name;
    else if (this.selfJid != null && !this.ownChatMissLogged) {
      this.ownChatMissLogged = true;
      this.callbacks.onLog(
        `whatsapp-web: own chat not found in ${chats.length} chats (self ${this.selfJid}, lid ${this.selfLid ?? "unknown"})`
      );
    }
    const seen = new Set<string>();
    this.contacts = chats
      .filter((chat) => !this.isOwnChat(chat.jid))
      .filter((chat) => {
        if (seen.has(chat.name)) return false;
        seen.add(chat.name);
        return true;
      })
      .map((chat) => ({
        chatId: chat.name,
        name: chat.name,
        isGroup: chat.isGroup === true,
      }));
  }

  /**
   * Whether a chat is the user's own: the one place identity is matched.
   * Newer WhatsApp builds file it under the account's "lid", not the phone
   * jid; comparing the phone jid alone lists the self chat as a stranger and
   * drops every self message as our own outgoing.
   */
  private isOwnChat(jid: string): boolean {
    if (this.ownChatJid != null && jid === this.ownChatJid) return true;
    const chat = this.bridgeChats.find((row) => row.jid === jid);
    if (chat?.isMe === true) return true;
    const user = jid.split("@")[0];
    if (user == null || user.length === 0) return false;
    return [this.selfJid, this.selfLid].some(
      (own) => own != null && own.split("@")[0] === user
    );
  }

  /** isOwnChat, asking the page when the chat list (minutes behind history
   * sync on a fresh link) cannot say. */
  private async judgeOwnChat(message: BridgeMessage): Promise<boolean> {
    if (this.isOwnChat(message.jid)) return true;
    if (message.chatIsMe === true) {
      this.rememberOwnChat(message.jid);
      return true;
    }
    // Only a fromMe message on a chat the list has not named needs the
    // page's word; everything else is settled already.
    if (!message.fromMe || this.bridge == null) return false;
    const known = this.ownChatVerdicts.get(message.jid);
    if (known != null) return known;
    const verdict = (await this.bridge.isOwnChat(message.jid)) === true;
    this.ownChatVerdicts.set(message.jid, verdict);
    if (verdict) this.rememberOwnChat(message.jid);
    else
      this.callbacks.onLog(
        `whatsapp-web: own outgoing in ${message.jid} is not the self chat, not inbound`
      );
    return verdict;
  }

  private rememberOwnChat(jid: string): void {
    if (this.ownChatJid === jid) return;
    this.ownChatJid = jid;
    this.callbacks.onLog(
      `whatsapp-web: the self chat is ${jid} (known without the chat list)`
    );
  }

  /** A chat id as the app uses it -> the WhatsApp id, via the bridge's list. */
  private async toJid(chatId: string): Promise<string> {
    if (this.self != null && chatId === this.self && this.selfJid != null)
      return this.selfJid;
    // A number or an id needs no list; a name does, and right after a link
    // WhatsApp is still syncing it: wait for it rather than call the name unknown.
    if ("error" in resolveJid(chatId, []) && !this.contactsReady())
      await this.waitForChatList(chatId);
    let resolved = resolveJid(chatId, this.bridgeChats);
    if ("error" in resolved) {
      // The list is a snapshot; a chat that started since is worth one
      // refresh before the name is declared unknown.
      await this.refreshBridgeChats();
      resolved = resolveJid(chatId, this.bridgeChats);
    }
    if ("error" in resolved) throw new Error(resolved.error);
    return resolved.jid;
  }

  /**
   * Send through the bridge and wait for the server's ack. A retry of a
   * queued-but-unacked text asks for that ack first: the message may have
   * gone out once the connection returned, and a second copy is worse.
   */
  private async sendViaBridge(chatId: string, chunk: string): Promise<void> {
    if (this.bridge == null) throw new Error("bridge not attached");
    const jid = await this.toJid(chatId);
    const key = `${jid}\u0000${chunk}`;

    const pending = this.queuedSends.get(key);
    if (pending != null) {
      const ack = await this.bridge.ackOf(pending);
      if (ack >= 1) {
        this.queuedSends.delete(key);
        this.callbacks.onLog(
          "whatsapp-web: the earlier queued send has since been accepted, not resending"
        );
        return;
      }
    }

    try {
      const sent = await this.bridge.sendText(jid, chunk);
      this.sentIds.add(sent.id);
      this.queuedSends.delete(key);
    } catch (error) {
      if (error instanceof QueuedSendError) {
        this.sentIds.add(error.messageId);
        this.queuedSends.set(key, error.messageId);
      }
      throw error;
    }
  }

  /** Outgoing bubbles whose text matches: the heal's stale-match baseline. */
  private async matchingOutCount(
    chatId: string,
    chunk: string
  ): Promise<number> {
    const opened = await this.openChat(chatId);
    if (!opened.ok) return 0;
    const result = await this.run<{ count: number }>(
      MATCHING_OUT_COUNT_SCRIPT,
      {
        head: chunk
          .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
          .slice(0, 48),
      }
    );
    return result?.count ?? 0;
  }

  private async sendChunk(chatId: string, text: string): Promise<void> {
    const win = this.ensureWindow();
    if (win == null || win.isDestroyed())
      throw new Error("WhatsApp is not running.");

    const composer = await this.openComposer(chatId);

    // Counted BEFORE anything is typed: the read-back below must see a NEW
    // bubble, since an old bubble with similar text would match the probe.
    const before = await this.run<{ bubbles: number }>(BUBBLE_COUNT_SCRIPT, {});

    this.trustedClick(win, composer.x, composer.y);
    await delay(150);
    win.webContents.insertText(text);
    await delay(200);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await delay(400);

    let cleared = await this.run<{ empty: boolean }>(COMPOSER_EMPTY_SCRIPT, {});
    if (cleared?.empty !== true) {
      // A freshly hydrated editor can hold the text while its Enter handler
      // is still attaching; one more Enter after a beat sends it.
      await delay(800);
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
      win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
      await delay(600);
      cleared = await this.run<{ empty: boolean }>(COMPOSER_EMPTY_SCRIPT, {});
    }
    if (cleared?.empty !== true) {
      // With WhatsApp's "Enter is send" setting off, every Enter above only
      // added a newline. The send BUTTON works regardless of that setting.
      const button = await this.run<{ ok: boolean; x?: number; y?: number }>(
        SEND_BUTTON_SCRIPT,
        {}
      );
      if (button?.ok === true && button.x != null && button.y != null) {
        this.trustedClick(win, button.x, button.y);
        await delay(600);
        cleared = await this.run<{ empty: boolean }>(COMPOSER_EMPTY_SCRIPT, {});
      }
    }
    if (cleared?.empty !== true)
      throw new Error(`The message to ${chatId} was typed but did not send.`);

    // An empty composer is necessary, not sufficient: an insertText that never
    // landed leaves it just as empty. Emoji are stripped from the probe (they
    // render as images, invisible to innerText) so a false "not sent" cannot
    // cause a duplicate; a pure-emoji message keeps the composer check only.
    const sent = await this.run<{ ok: boolean; error?: string }>(
      SENT_VERIFY_SCRIPT,
      {
        head: text
          .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
          .slice(0, 48),
        priorCount: before?.bubbles ?? -1,
      }
    );
    if (sent?.ok !== true)
      throw new Error(
        `The message to ${chatId} cleared the composer but this check could ` +
          `not see it in the chat (${sent?.error ?? "no answer"}). Do NOT ` +
          "resend it yet: first read the chat (read_chat_messages) and check " +
          "whether it actually arrived. A resend after a send that in fact " +
          "worked delivers the same message twice. Resend only if the read " +
          "shows it truly missing."
      );
  }

  /**
   * Open the chat and wait for its message box, once and then once more: just
   * after a link, a row click can land on a pane that has not finished
   * mounting. A chat that cannot be found is not retried.
   */
  private async openComposer(
    chatId: string
  ): Promise<{ x: number; y: number }> {
    let lastError: string | null = null;

    for (const attempt of [0, 1]) {
      const opened = await this.openChat(chatId);
      if (!opened.ok)
        throw new Error(
          opened.error ?? `Could not open the WhatsApp chat with ${chatId}.`
        );

      // A row click can land on a different chat. Only the conversation's
      // own top bar naming the requested chat makes it safe to type into.
      const numberTarget = /^\+?[\d\s-]{7,18}$/.test(chatId);
      const matches = numberTarget
        ? { ok: true as const, bar: "" }
        : await this.run<{ ok: boolean; bar?: string }>(CHAT_MATCHES_SCRIPT, {
            name: chatId,
          });
      if (matches?.ok !== true) {
        lastError = `a different chat opened (top bar: ${matches?.bar ?? "unreadable"})`;
        if (attempt === 0) {
          this.callbacks.onLog(
            `whatsapp-web: asked for ${chatId} but ${lastError}, trying once more`
          );
          await delay(COMPOSER_RETRY_DELAY_MS);
        }
        continue;
      }

      const composer = await this.run<{
        ok: boolean;
        error?: string;
        x?: number;
        y?: number;
      }>(COMPOSER_SCRIPT, {});

      if (composer?.ok === true && composer.x != null && composer.y != null)
        return { x: composer.x, y: composer.y };

      lastError = composer?.error ?? "no message box";
      if (attempt === 0) {
        this.callbacks.onLog(
          `whatsapp-web: no message box in ${chatId} yet, trying once more`
        );
        await delay(COMPOSER_RETRY_DELAY_MS);
      }
    }

    // Spelled out for the model: a bare "did not open" gets filled in as
    // "WhatsApp is not set up, scan a QR" to a user whose account is linked.
    throw new Error(
      `WhatsApp is linked, but its message box did not appear for "${chatId}" (${lastError}). ` +
        "Nothing was sent. This happens while WhatsApp is still loading an " +
        "account it has just linked. Do not tell the user to set up WhatsApp " +
        "or scan a QR; it is already linked. Say the send did not go through " +
        "and offer to try again in a moment."
    );
  }

  /**
   * Send a file: a TRUSTED click on the attach menu, the file set on its
   * `<input type="file">` through the debugger (no native picker opens), then
   * a real Enter to confirm the preview.
   */
  async sendFile(
    chatId: string,
    filePath: string,
    caption?: string
  ): Promise<void> {
    refuseNonConversation(chatId);
    return this.userCall(
      () => this.sendFileNow(chatId, filePath, caption),
      "send"
    );
  }

  private async sendFileNow(
    chatId: string,
    filePath: string,
    caption?: string
  ): Promise<void> {
    const win = this.ensureWindow();
    if (win == null || win.isDestroyed())
      throw new Error("WhatsApp is not running.");
    if (!this.loggedIn)
      throw new Error("WhatsApp is not linked yet. Scan the QR first.");

    // Waits out the same not-yet-mounted pane a text send does; the attach
    // button appears no sooner than the composer.
    await this.openComposer(chatId);

    const attach = await this.run<{
      ok: boolean;
      error?: string;
      x?: number;
      y?: number;
    }>(ATTACH_BUTTON_SCRIPT, {});
    if (attach?.ok !== true || attach.x == null || attach.y == null)
      throw new Error(attach?.error ?? "The attach button was not found.");

    this.trustedClick(win, attach.x, attach.y);
    await delay(500);
    await setFileInput(win, 'input[type="file"]', filePath);
    // The media preview takes a beat to render the file.
    await delay(1500);
    if (caption != null && caption.length > 0) {
      win.webContents.insertText(caption.slice(0, 1024));
      await delay(200);
    }
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await delay(1200);

    const preview = await this.run<{ open: boolean }>(
      MEDIA_PREVIEW_OPEN_SCRIPT,
      {}
    );
    if (preview?.open === true)
      throw new Error(
        `The file was staged but did not send to ${chatId}. The preview is still open.`
      );
    this.rememberSent(chatId, caption ?? "");
  }

  /** Open a chat by name or number. The script finds the row (on screen or
   * via search); the click must be TRUSTED, WhatsApp ignores synthetic ones. */
  private async openChat(
    target: string
  ): Promise<{ ok: boolean; error?: string }> {
    const win = this.ensureWindow();
    if (win == null || win.isDestroyed())
      return { ok: false, error: "WhatsApp is not running." };

    // A number-shaped target (always "me") takes the deterministic
    // /send?phone= route: nothing for drifting markup to misaim.
    const digits = /^\+?(\d{7,15})$/.exec(target.replace(/[\s-]/g, ""));
    if (digits != null) {
      // Already there? Then do NOT reload: a reload per send races composer
      // hydration, and text lands in a box whose Enter is not wired yet.
      if (this.lastNumberOpened === digits[1]) {
        const still = await this.run<{ ok: boolean }>(
          COMPOSER_PRESENT_SCRIPT,
          {}
        );
        if (still?.ok === true) return { ok: true };
      }
      this.lastNumberOpened = null;
      await win
        .loadURL(`https://web.whatsapp.com/send?phone=${digits[1]}`, {
          userAgent: userAgent(),
        })
        .catch(() => {});
      // The page reloads; give the conversation time to mount.
      const settled = await this.run<{ ok: boolean }>(
        NUMBER_OPEN_SETTLED_SCRIPT,
        {}
      );
      if (settled?.ok !== true)
        return {
          ok: false,
          error: `WhatsApp did not open a chat for ${target}.`,
        };
      // The composer exists, but a freshly loaded editor accepts text before
      // it is wired to send. Give hydration a beat.
      await delay(1500);
      this.lastNumberOpened = digits[1];
      return { ok: true };
    }

    let found = await this.run<{
      ok: boolean;
      error?: string;
      needTrustedType?: boolean;
      x?: number;
      y?: number;
    }>(FIND_CHAT_SCRIPT, { target });
    if (
      found?.ok !== true &&
      found?.needTrustedType === true &&
      found.x != null &&
      found.y != null
    ) {
      // The search box ignored synthetic input; type through the real
      // input pipeline, the way the composer is driven.
      this.trustedClick(win, found.x, found.y);
      await delay(200);
      win.webContents.insertText(target);
      await delay(300);
      found = await this.run<{
        ok: boolean;
        error?: string;
        x?: number;
        y?: number;
      }>(FIND_ROW_AFTER_TYPE_SCRIPT, { target });
    }
    if (found?.ok !== true || found.x == null || found.y == null)
      return {
        ok: false,
        error: found?.error ?? `No WhatsApp chat matched "${target}".`,
      };

    this.trustedClick(win, found.x, found.y);
    await delay(300);
    // A row click navigated away from whatever number-opened chat was up.
    this.lastNumberOpened = null;
    return { ok: true };
  }

  /** A real click, so Lexical's selection actually moves. */
  private trustedClick(win: BrowserWindow, x: number, y: number): void {
    win.webContents.sendInputEvent({
      type: "mouseDown",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    win.webContents.sendInputEvent({
      type: "mouseUp",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  listContacts(): Array<{ chatId: string; name: string; isGroup?: boolean }> {
    // The user's own chat leads the list, named for what it is: under its
    // WhatsApp title it reads to the model as a stranger with the user's name.
    if (this.self == null) return this.contacts;
    const title =
      this.selfDisplayName != null && this.selfDisplayName !== this.self
        ? `, shown in WhatsApp as "${this.selfDisplayName}"`
        : "";
    const me = {
      chatId: this.self,
      name: `You (the user's own account, the "Message yourself" chat${title}; also reachable as "me")`,
    };
    return [
      me,
      ...this.contacts.filter(
        (row) =>
          row.chatId !== this.self &&
          (this.selfDisplayName == null || row.name !== this.selfDisplayName)
      ),
    ];
  }

  /** The account this WhatsApp is connected AS; connecting established it. */
  selfChatId(): string | null {
    return this.self;
  }

  async readChat(
    chatId: string,
    limit: number
  ): Promise<
    Array<{
      userName: string | null;
      text: string;
      direction: "in" | "out";
      at: string;
    }>
  > {
    return this.userCall(() => this.readChatNow(chatId, limit));
  }

  /** Chats with messages waiting. Bridge only: unread badges off the chat
   * list are a guess over pixels. Sends no read receipts. */
  async unreadChats(): Promise<
    Array<{ chatId: string; name: string; unreadCount: number }>
  > {
    return this.userCall(async () => {
      if (!this.loggedIn) throw new Error("WhatsApp is not linked right now.");
      if (this.bridge == null || !(await this.useBridge()))
        throw new Error(
          "WhatsApp's unread counts are out of reach: the store bridge is not attached to this session."
        );
      const chats = await this.bridge.listChats({ onlyUnread: true });
      if (chats == null)
        throw new Error(
          "WhatsApp is still syncing your chats, so unread counts are not available yet. Try again in a minute."
        );
      return chats
        .filter((chat) => !this.isOwnChat(chat.jid))
        .map((chat) => ({
          chatId: chat.name,
          name: chat.name,
          unreadCount: chat.unreadCount,
        }));
    });
  }

  private async readChatNow(
    chatId: string,
    limit: number
  ): Promise<
    Array<{
      userName: string | null;
      text: string;
      direction: "in" | "out";
      at: string;
    }>
  > {
    if (!this.loggedIn) return [];
    if (this.bridge != null && (await this.useBridge())) {
      const jid = await this.toJid(chatId);
      const read: BridgeRead = await this.bridge.readChat(jid, limit);
      if (read.ok === true) {
        const chat = this.bridgeChats.find((row) => row.jid === jid);
        return read.rows.map((row) => ({
          userName: row.fromMe
            ? null
            : chat?.isGroup === true
              ? row.senderName
              : (chat?.name ?? row.senderName),
          text: normalizeScrapedText(row.text),
          direction: row.fromMe ? "out" : "in",
          at: new Date(row.t * 1000).toISOString(),
        }));
      }
      // No page fallback here: navigating WhatsApp Web detaches the bridge,
      // loses its inbound queue and restarts WhatsApp's sync.
      this.callbacks.onLog(
        `whatsapp-web: ${jid} is not in the store (${read.reason}); not reloading the page for it`
      );
      throw new Error(
        `WhatsApp has not loaded the chat "${chatId}" on this device yet. It does that for a while after linking. Ask again in a minute; no browser or reload is needed.`
      );
    }
    const opened = await this.openChat(chatId);
    if (!opened.ok)
      throw new Error(
        `WhatsApp could not open the chat with ${chatId}, so its messages could not be read${opened.error == null ? "" : `: ${opened.error}`}. This is not the same as the chat being empty. Check the contact or number.`
      );
    const rows = await this.run<
      Array<{
        userName: string | null;
        text: string;
        direction: "in" | "out";
        at: string;
      }>
    >(READ_CHAT_SCRIPT, { limit });
    return rows ?? [];
  }

  async searchMessages(
    query: string,
    limit: number
  ): Promise<
    Array<{ chatId: string; name: string; snippet: string; when: string }>
  > {
    return this.userCall(() => this.searchMessagesNow(query, limit));
  }

  private async searchMessagesNow(
    query: string,
    limit: number
  ): Promise<
    Array<{ chatId: string; name: string; snippet: string; when: string }>
  > {
    if (!this.loggedIn) return [];
    const rows = await this.run<
      Array<{ chatId: string; name: string; snippet: string; when: string }>
    >(SEARCH_MESSAGES_SCRIPT, { query, limit });
    // The search box replaced whatever chat a /send?phone= had opened.
    this.lastNumberOpened = null;
    return rows ?? [];
  }

  // ── Login ──────────────────────────────────────────────────────────────

  private pollLogin(): void {
    this.loginPoll.start();
  }

  /** See MessagingConnector.probeLive: one login check, now, then the answer. */
  async probeLive(): Promise<boolean> {
    // A parked lane has no page, and a probe must not load one.
    if (!this.running || this.parkedNote != null) return false;
    try {
      await this.checkLogin();
    } catch {
      // A page that cannot be read right now leaves the last verdict standing.
    }
    return this.loggedIn;
  }

  private async checkLogin(): Promise<void> {
    if (!this.running || this.parkedNote != null) return;
    // Never judge a page the connector is driving: a send's search takes the
    // chat list, the probe's evidence, off the DOM and reads as a logout.
    if (this.lock.busy) {
      this.signedOutTicks = 0;
      return;
    }
    const state = await this.run<LoginState>(LOGIN_STATE_SCRIPT, {});
    if (state == null || this.parkedNote != null) return;

    if (state.loggedIn) this.signedOutTicks = 0;
    this.qrTicks =
      !state.loggedIn && state.loginVisible === true ? this.qrTicks + 1 : 0;

    if (state.loggedIn && !this.loggedIn) {
      this.loggedIn = true;
      this.link = "connected";
      this.linkReported = false;
      this.stuckReloads = 0;
      this.recordSignedIn(true);
      const win = this.window;
      if (win != null && !win.isDestroyed() && win.isVisible()) {
        win.hide();
        // The login window is what the user was looking at; put the app in
        // front of them rather than whatever the OS picks after a hide.
        bringToFront();
      }
      this.callbacks.onState("connected");
      // The login poll KEEPS RUNNING after connect; it is the only thing
      // that notices a session removed from the phone.
      this.startInboundPolling();
      // Serialized: the self lookup NAVIGATES the page, and outside the lock
      // the login poll would read a mid-navigation page as logged out.
      void this.serialize(async () => {
        // With the bridge attached the chat list comes from it, whole; a
        // page scrape alongside re-adds the self chat as an ordinary contact.
        if (await this.ensureBridge()) {
          await this.findSelf();
          return;
        }
        await this.refreshContacts();
      });
      return;
    }

    // A login screen is a wait on a human, not a failure: `needs_login` keeps
    // the gateway from restarting the connector. The window is shown only
    // from the connect dialog, never from a background restart.
    // Believed after a few polls, it is recorded so the next launch loads no page.
    if (!state.loggedIn && !this.loggedIn && state.loginVisible === true) {
      if (this.qrTicks >= QR_BELIEVED_POLLS) this.recordSignedIn(false);
      this.callbacks.onState(
        "needs_login",
        "WhatsApp is not linked. Scan the QR from your phone (Settings → Linked devices) to connect."
      );
      return;
    }

    if (!state.loggedIn && this.loggedIn) {
      // A QR is a real logout, believed after a few polls. A page with neither
      // QR nor chat list is WhatsApp booting (every /send?phone= reloads the
      // SPA) and must stay blank a full minute, or a slow boot wipes the link
      // and flaps forever. Blank past that is a dead page, not a logout.
      this.signedOutTicks += 1;
      if (this.signedOutTicks < (state.loginVisible === true ? 4 : 40)) return;
      this.signedOutTicks = 0;
      if (state.loginVisible !== true) {
        this.relink("after WhatsApp Web went blank");
        return;
      }
      this.unlinked();
    }
  }

  /** The phone unlinked this device: say so, and wait for a new link. */
  private unlinked(): void {
    if (this.relinkTimer != null) clearTimeout(this.relinkTimer);
    this.relinkTimer = null;
    this.link = "needs_relink";
    this.linkReported = false;
    // Report the link as broken, not "connecting": whoever this was, it is
    // not that account any more.
    this.loggedIn = false;
    this.self = null;
    this.selfJid = null;
    this.selfLid = null;
    this.ownChatJid = null;
    this.ownChatMissLogged = false;
    this.ownChatVerdicts.clear();
    this.selfDisplayName = null;
    this.lastNumberOpened = null;
    this.bridgeReady = false;
    this.bridgeExpected = false;
    // A different phone may be on the other end of the next link.
    this.selfLookupDone = false;
    this.selfLinkedAnnounced = false;
    this.recordSignedIn(false);
    this.callbacks.onState(
      "needs_login",
      "WhatsApp is no longer linked. The phone unlinked this device or the session expired. Reconnect and scan the QR again."
    );
    this.pollLogin();
  }

  /** Bring the login window back to the front (re-scan, or first login). */
  showLoginWindow(): void {
    this.resume();
    const win = this.ensureWindow();
    if (win == null) return;
    // Adopt, fit, show, focus, leaving macOS full screen first.
    presentAsDialog(win);
  }

  /** Out of sight, still running: a scan already made can still land. */
  hideLoginWindow(): void {
    const win = this.window;
    if (win != null && !win.isDestroyed() && win.isVisible()) win.hide();
  }

  /** True once the user has linked the device; surfaced to the connect dialog. */
  get isLoggedIn(): boolean {
    return this.loggedIn;
  }

  // ── Parking ────────────────────────────────────────────────────────────

  /**
   * Stop checking and drop the page until the user clicks Connect. The state
   * is one the gateway leaves alone (`needs_login`) or restarts only on the
   * user's next connect (`error`), so nothing loads the page again by itself.
   * The session stays in the partition; the next page signs in from it.
   */
  private park(state: "needs_login" | "error", note: string): void {
    this.parkedNote = note;
    this.loginPoll.stop();
    this.inboundPoll.stop();
    if (this.relinkTimer != null) clearTimeout(this.relinkTimer);
    this.relinkTimer = null;
    this.loggedIn = false;
    this.link = "connected";
    this.linkReported = false;
    this.signedOutTicks = 0;
    this.qrTicks = 0;
    this.bridgeReady = false;
    this.lastNumberOpened = null;
    const win = this.window;
    this.window = null;
    if (win != null && !win.isDestroyed()) win.destroy();
    this.callbacks.onState(state, note);
  }

  /** Parked for a page that did not load, with the note its failure earned. */
  private parkUnloaded(fallback: string): void {
    const failure = this.loadFailure;
    this.loadFailure = null;
    if (failure === "cert") {
      this.park("error", CERT_BLOCKED);
      return;
    }
    this.park("error", failure === "network" ? UNREACHABLE : fallback);
    // Started before the network was up (a login item at boot), or dropped
    // since: one more try once it is back. Online means the site itself.
    if (failure === "network" && !net.isOnline()) this.retryWhenOnline();
  }

  /** The user clicked Connect: a fresh start for the checks and the page. */
  private resume(): void {
    this.stuckReloads = 0;
    this.qrTicks = 0;
    this.stopOnlineCheck();
    if (!this.running || this.parkedNote == null) return;
    this.parkedNote = null;
    this.callbacks.onLog("whatsapp-web: opened by the user, checking again");
    this.callbacks.onState("connecting");
    this.pollLogin();
  }

  private recordSignedIn(signedIn: boolean): void {
    if (this.signedInRecord === signedIn) return;
    this.signedInRecord = signedIn;
    savePlatformSignedIn(this.id, signedIn);
  }

  /**
   * The page itself could not load. Before a link nothing reloads it, so the
   * lane waits on the user at once; after one, the failure is noted and the
   * relink's bounded reloads decide, since a navigation can fail mid-use and
   * come back.
   */
  private onLoadFailed(code: number, description: string): void {
    if (!this.running || this.parkedNote != null) return;
    this.loadFailure = isCertError(code) ? "cert" : "network";
    if (this.loggedIn) return;
    this.callbacks.onLog(
      `whatsapp-web: page failed to load (${code} ${description}), waiting for the user`
    );
    this.parkUnloaded(UNREACHABLE);
  }

  private retryWhenOnline(): void {
    this.stopOnlineCheck();
    this.onlineCheck = setInterval(() => {
      if (!net.isOnline()) return;
      this.stopOnlineCheck();
      if (!this.running || this.parkedNote == null) return;
      this.callbacks.onLog("whatsapp-web: back online, loading the page again");
      this.resume();
      this.ensureWindow();
    }, ONLINE_CHECK_MS);
  }

  private stopOnlineCheck(): void {
    if (this.onlineCheck == null) return;
    clearInterval(this.onlineCheck);
    this.onlineCheck = null;
  }

  // ── Inbound + contacts ─────────────────────────────────────────────────

  private startInboundPolling(): void {
    this.firstInboundSweep = true;
    this.inboundPoll.start();
  }

  private async sweepInbound(): Promise<void> {
    if (!this.running || !this.loggedIn || this.link !== "connected") return;
    return this.serialize(() => this.sweepInboundNow());
  }

  private async sweepInboundNow(): Promise<void> {
    if (!this.running || !this.loggedIn || this.link !== "connected") return;
    if (await this.useBridge()) {
      await this.sweepBridgeInbound();
      return;
    }
    // The page driver retries the bridge now and then, never every sweep.
    if (Date.now() - this.lastAttachTry > BRIDGE_RETRY_MS) {
      this.lastAttachTry = Date.now();
      if (await this.ensureBridge()) return;
    }
    await this.refreshContacts();
    const rows = await this.run<
      Array<{ chatId: string; name: string; text: string; messageId: string }>
    >(INBOUND_SCRIPT, { selfName: this.selfDisplayName ?? "" });
    if (rows == null) return;

    for (const row of rows) {
      // Checked on the raw text: the signature is exactly what normalization
      // strips.
      const botOutput = looksLikeBotOutput(row.text);
      row.text = normalizeScrapedText(row.text);
      const previous = this.lastSeen.get(row.chatId);
      this.lastSeen.set(row.chatId, row.messageId);
      // The first sweep only seeds lastSeen, so existing unreads do not
      // replay into the agent on connect.
      if (this.firstInboundSweep) continue;
      if (previous === row.messageId) continue;
      // "typing…" and friends are presence, not messages.
      if (isEphemeralPreview(row.text)) continue;
      // A chat's preview changes when WE send into it; an older unread badge
      // keeps the row in the sweep, and the bot would answer its own reply.
      if (previewMatchesSent(this.lastSentTexts.get(row.chatId), row.text))
        continue;
      // The self chat surfaces under its display title, but its identity is
      // the account's own number.
      const isSelfRow =
        this.selfDisplayName != null && row.name === this.selfDisplayName;
      const chatId = isSelfRow ? (this.self ?? row.chatId) : row.chatId;
      if (previewMatchesSent(this.lastSentTexts.get(chatId), row.text))
        continue;
      if (isSelfRow && botOutput) {
        this.callbacks.onLog(
          "whatsapp-web: a bot's words in the self chat, not the user's; not reporting it"
        );
        continue;
      }
      this.callbacks.onMessage({
        userId: chatId,
        userName: row.name,
        chatId,
        text: row.text,
      });
    }
    this.firstInboundSweep = false;
  }

  /**
   * Inbound off the bridge's event queue. The self chat is the one place a
   * `fromMe` message is real inbound (the user typing from the phone), so
   * only there do those pass, minus the ids this session sent.
   */
  private async sweepBridgeInbound(): Promise<void> {
    if (this.bridge == null) return;
    await this.findSelf();
    // The chat list is a snapshot: refresh it every minute, or every few
    // sweeps while it has never answered.
    this.sweepCount += 1;
    if (
      this.sweepCount % 12 === 1 ||
      (this.bridgeChats.length === 0 && this.sweepCount % 3 === 1)
    )
      await this.refreshBridgeChats();

    const { messages, loggedOut } = await this.bridge.drain();
    if (loggedOut) {
      this.callbacks.onLog(
        "whatsapp-web: the bridge saw a logout: the phone unlinked this device"
      );
      // The login poll's own check confirms it and moves the state.
      this.signedOutTicks = 40;
      return;
    }
    if (this.firstInboundSweep) {
      // Same contract as the DOM path: no replay on connect.
      this.firstInboundSweep = false;
    }
    for (const message of messages) {
      if (this.sentIds.has(message.id)) continue;
      const isSelfChat = await this.judgeOwnChat(message);
      if (message.fromMe && !isSelfChat) continue;
      // Signed by an AbacusBot, this one or another install on the same
      // phone. Raw text, before normalization strips the signature.
      if (isSelfChat && message.fromMe && looksLikeBotOutput(message.text)) {
        this.callbacks.onLog(
          "whatsapp-web: a bot's words in the self chat, not the user's; not reporting it"
        );
        continue;
      }
      const text = normalizeScrapedText(message.text);
      if (text.length === 0) continue;
      if (isEphemeralPreview(text)) continue;
      const chat = this.bridgeChats.find((row) => row.jid === message.jid);
      const chatId = isSelfChat
        ? (this.self ?? message.jid)
        : (chat?.name ?? message.jid);
      // Our own echo, by text, for the self chat where fromMe is ambiguous.
      if (previewMatchesSent(this.lastSentTexts.get(chatId), text)) continue;
      // In a direct chat the sender is the saved contact name: a profile name
      // matching the user's own would label the message as the user's. The
      // profile name is right only in a group.
      const userName = isSelfChat
        ? (this.selfDisplayName ?? chatId)
        : chat?.isGroup === true
          ? (message.senderName ?? chat.name)
          : (chat?.name ?? message.senderName ?? chatId);
      this.callbacks.onMessage({
        userId: chatId,
        userName,
        chatId,
        text,
      });
    }
  }

  private async refreshContacts(): Promise<void> {
    const result = await this.run<{
      rows: Array<{ chatId: string; name: string }>;
    }>(CONTACTS_SCRIPT, {});
    if (result == null) return;
    // Merge, never replace: the chat list is virtualized, so one scrape only
    // sees the rows rendered around the current scroll position.
    const known = new Set(this.contacts.map((row) => row.name));
    for (const row of result.rows) {
      if (known.has(row.name)) continue;
      known.add(row.name);
      this.contacts.push(row);
    }
    if (!this.paneShapeLogged) {
      this.paneShapeLogged = true;
      const shape = await this.run<Record<string, unknown>>(
        PANE_SHAPE_SCRIPT,
        {}
      );
      this.callbacks.onLog(
        `whatsapp-web: pane shape ${JSON.stringify(shape)}, ${this.contacts.length} contacts read`
      );
    }
    await this.findSelf();
  }

  /**
   * Ask who this session is linked as, once per link. A failure is logged
   * with the step that failed; a silent null ends with the user asked for
   * the number of the phone they just paired.
   */
  private async findSelf(): Promise<void> {
    if (this.selfLookupDone) return;

    // The bridge answers exactly, from WhatsApp's connection state.
    if (this.bridge != null && this.bridgeReady) {
      const me = await this.bridge.myId();
      if (me != null) {
        this.selfLookupDone = true;
        this.selfJid = me.jid;
        this.selfLid = me.lid;
        this.self = `+${me.digits}`;
        this.callbacks.onLog(
          `whatsapp-web: linked as +…${me.digits.slice(-4)} (own id, via bridge)`
        );
        this.announceSelfLinked();
        // With self known, the own chat can be kept out of the contacts.
        await this.refreshBridgeChats();
        if (this.selfDisplayName != null)
          this.callbacks.onLog(
            `whatsapp-web: the self chat shows as "${this.selfDisplayName}"`
          );
        return;
      }
    }

    this.selfLookupDone = true;

    // "Me" IS the account's own number, read from WhatsApp's login keys: the
    // one identity nothing on the page can misattribute.
    const found = await this.run<{ digits: string | null; how: string }>(
      OWN_DIGITS_SCRIPT,
      {}
    );
    if (found?.digits == null || found.digits.length === 0) {
      this.callbacks.onLog(
        `whatsapp-web: could not read the linked account's own number (${found?.how ?? "no answer"}); ` +
          "sending to yourself will not work until it can"
      );
      return;
    }

    this.self = `+${found.digits}`;
    this.callbacks.onLog(
      `whatsapp-web: linked as +…${found.digits.slice(-4)} (own number, via ${found.how})`
    );
    this.announceSelfLinked();

    // The display name matters for the sweep's always-watch of the self chat
    // (self-sent messages are born read and never grow an unread badge).
    const opened = await this.openChat(this.self);
    if (opened.ok) {
      const bar = await this.run<{ ok: boolean; bar?: string }>(
        CHAT_MATCHES_SCRIPT,
        { name: "" }
      );
      const title = (bar?.bar ?? "").split(/click here/i)[0]?.trim();
      if (title != null && title.length > 0) {
        this.selfDisplayName = title;
        this.callbacks.onLog(`whatsapp-web: the self chat shows as "${title}"`);
      }
    }
  }

  /** Once per link: mints the "Message yourself" bot and starts it. */
  private announceSelfLinked(): void {
    if (this.selfLinkedAnnounced || this.self == null) return;
    this.selfLinkedAnnounced = true;
    this.callbacks.onSelfLinked?.();
  }

  // ── Page driving ────────────────────────────────────────────────────────

  private buildWindow(visible: boolean): BrowserWindow {
    const win = new BrowserWindow({
      show: visible,
      width: 1100,
      height: 760,
      title: "Link WhatsApp",
      // A child of the app window so it shares the app's Space; top-level,
      // a full-screen app leaves the user on an empty Space after login.
      ...(parentWindow() != null ? { parent: parentWindow() } : {}),
      // NOT modal (a native macOS sheet the app does not survive) and
      // frameless: chrome on a login overlay reads as a second app.
      autoHideMenuBar: true,
      frame: false,
      // Kept painting and unthrottled while hidden so trusted clicks and
      // waits on async renders work with no window on screen.
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition: WHATSAPP_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.setUserAgent(userAgent());
    // Hidden or not, the page still plays WhatsApp's notification sound; the
    // app has its own notifications.
    win.webContents.setAudioMuted(true);
    // Gone entirely, not just auto-hidden: Alt would bring it back. macOS
    // has no per-window menu.
    if (process.platform !== "darwin") win.removeMenu();
    // The frameless window has no close button of its own.
    dismissOnEscape(win);

    // A user who closes the login window has not disabled the platform; drop
    // the handle and let the next send or sweep rebuild it via ensureWindow.
    win.on("closed", () => {
      if (this.window === win) this.window = null;
    });
    // Every load is a fresh page; whatever the bridge injected is gone, and
    // the relink puts it back.
    win.webContents.on("did-finish-load", () => {
      this.bridge?.reset();
      this.bridgeReady = false;
      if (this.bridgeExpected) this.relink(RELOADED);
    });
    win.webContents.on(
      "did-fail-load",
      (_event, code, description, _url, isMainFrame) => {
        if (!isMainFrame || code === NET_ERR_ABORTED) return;
        if (this.window === win) this.onLoadFailed(code, description);
      }
    );
    // Chromium refuses the certificate on its own; this only reads the verdict.
    win.webContents.on("certificate-error", (_event, url, error) => {
      if (this.window !== win || !url.startsWith(WHATSAPP_WEB_URL)) return;
      this.onLoadFailed(-200, error);
    });
    return win;
  }

  private ensureWindow(): BrowserWindow | null {
    if (this.window != null && !this.window.isDestroyed()) return this.window;
    if (!this.running || this.parkedNote != null) return null;
    // Hidden even when logged out: whoever needs the user's eyes on it
    // (showLoginWindow, the login-screen check) shows it explicitly.
    const win = this.buildWindow(false);
    void win.loadURL(WHATSAPP_WEB_URL, { userAgent: userAgent() });
    this.window = win;
    return win;
  }

  /** Run one driver script in the page (an async IIFE, for top-level await)
   * and return its JSON value. A throw resolves to null: not ready yet. A
   * call cut short throws; a page that stops answering starts a relink. */
  private async run<T>(
    script: PageScript,
    args: Record<string, unknown>
  ): Promise<T | null> {
    const signal = this.lock.signal;
    signal?.throwIfAborted();
    const win = this.ensureWindow();
    if (win == null || win.isDestroyed()) return null;
    try {
      const value = (await boundedWait(
        runPageScript(win.webContents, script, args),
        SCRIPT_STALL_MS,
        signal
      )) as T;
      return value ?? null;
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason;
      if (error instanceof PageStalledError)
        this.relink("after the page stopped answering");
      this.callbacks.onLog(
        `whatsapp-web: script failed: ${String((error as Error)?.message ?? error)}`
      );
      return null;
    }
  }
}

// ── Driver scripts (run in web.whatsapp.com's page) ────────────────────────
// Each returns a JSON-serialisable value.

/** `#pane-side` exists only inside the linked app, never on the QR page or
 * mid-boot: a positive marker immune to the boot flash. */
const LOGIN_STATE_SCRIPT = pageScript`
  const loggedIn = !!document.querySelector('#pane-side');
  // Only consulted while logged out, where a canvas can only be the QR.
  const loginVisible = !loggedIn &&
    !!document.querySelector('[data-testid="qrcode"], [data-link-device], canvas');
  return { loggedIn, loginVisible };
`;

/** Shared helpers, inlined at the top of the scripts that need them. */
const HELPERS = pageScript`
  // Primary: the role-attributed rows. Fallback, for builds where the roles
  // vanished (contacts read as empty and the sweep went blind): every chat
  // row carries exactly one title span, so rows are rediscovered as the
  // title spans' enclosing boxes.
  const chatRows = () => {
    const primary = [...document.querySelectorAll('#pane-side [role="row"], #pane-side [role="listitem"]')];
    if (primary.length > 0) return primary;
    const seen = new Set();
    const rows = [];
    for (const t of document.querySelectorAll('#pane-side span[title]')) {
      let el = t;
      for (let i = 0; i < 4 && el.parentElement; i++) el = el.parentElement;
      if (!seen.has(el)) { seen.add(el); rows.push(el); }
    }
    return rows;
  };
  const rowName = (el) => {
    const t = el.querySelector('[data-testid="cell-frame-title"] span[title], span[title]');
    return (t ? t.getAttribute('title') || t.textContent : '').trim();
  };
  // A modal (the "What's new" tour and its kind) swallows the trusted clicks
  // a send needs. One with a single button is an announcement: dismiss it.
  // These dialogs are plain React, so a synthetic click works.
  const dismissModal = () => {
    const modal = document.querySelector('[data-animate-modal-popup="true"], div[aria-modal="true"]');
    if (!modal) return;
    const buttons = modal.querySelectorAll('button');
    if (buttons.length === 1) buttons[0].click();
  };
`;

/**
 * The linked account's own number, from WhatsApp's client storage (the
 * virtualised chat list may not hold the self row). Only the keys WhatsApp
 * stores its identity under count: a scan for anything WID-shaped can crown a
 * cached business contact as "me", and every self-send goes to a stranger.
 */
const OWN_DIGITS_SCRIPT = pageScript`
  // Only WhatsApp's own record of the LINKED account counts: these are the
  // keys WhatsApp Web stores its login identity under. Scanning every
  // stored value for anything WID-shaped once crowned a cached business
  // contact as "me".
  try {
    for (const key of ['last-wid-md', 'last-wid']) {
      const value = localStorage.getItem(key) || '';
      const match = /(\\d{7,15})(?::\\d+)?@c\\.us/.exec(value);
      if (match) return { digits: match[1], how: key };
    }
  } catch (err) {
    return { digits: null, how: 'storage-unreadable' };
  }
  return { digits: null, how: 'no-self-wid' };
`;

/** What the chat-list pane is made of, logged once per connect: selector
 * generations die silently. Counts only; no personal data. */
const PANE_SHAPE_SCRIPT = pageScript`
  const q = (sel) => document.querySelectorAll(sel).length;
  const pane = document.querySelector('#pane-side');
  return {
    pane: !!pane,
    roleRows: q('#pane-side [role="row"]'),
    listItems: q('#pane-side [role="listitem"]'),
    titleSpans: q('#pane-side span[title]'),
    anySpans: q('#pane-side span'),
    links: q('#pane-side a'),
    divs: pane ? pane.querySelectorAll('div').length : 0,
    grid: q('#pane-side [role="grid"], #pane-side [role="list"]'),
  };
`;

/** The chat list as contacts. The DOM exposes no jids, so the display name
 * doubles as the id, which is also what openChat resolves. */
const CONTACTS_SCRIPT = pageScript`
  ${HELPERS}
  const rows = [];
  const seen = new Set();
  for (const el of chatRows()) {
    const name = rowName(el);
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    rows.push({ chatId: name, name });
    if (rows.length >= 200) break;
  }
  return { rows };
`;

/**
 * Chat rows carrying an unread badge. The self chat (args.selfName) is
 * reported even without one: a message the user sends themself is born read,
 * so its preview doubles as the change signal.
 */
const INBOUND_SCRIPT = pageScript`
  ${HELPERS}
  const rows = [];
  for (const el of chatRows()) {
    const name = rowName(el);
    if (name.length === 0) continue;
    const badge = el.querySelector('span[aria-label*="unread" i], [data-testid="icon-unread-count"]');
    const isSelf = args.selfName.length > 0 && name === args.selfName;
    if (!badge && !isSelf) continue;
    const previewEl =
      el.querySelector('[data-testid="cell-frame-secondary"] span[title]') ??
      el.querySelectorAll('span[title]')[1];
    const preview = (previewEl ? previewEl.getAttribute('title') || previewEl.textContent : '').trim();
    if (!badge && preview.length === 0) continue;
    const text = preview.length > 0 ? preview : name + ' has unread messages';
    rows.push({ chatId: name, name, text, messageId: name + ':' + text });
  }
  return rows;
`;

/**
 * Resolve `args.target` to a chat row's coordinates. Exact name before
 * contains, so "mom" finds "Mom" and not "Mombasa Trip". Off-screen rows go
 * through search, set via the native value setter + input event (plain
 * assignment is swallowed by the controlled component).
 */
const FIND_CHAT_SCRIPT = pageScript`
  ${HELPERS}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const target = String(args.target || '').trim();
  if (target.length === 0) return { ok: false, error: 'No recipient.' };
  const wanted = target.toLowerCase();
  dismissModal();
  const centre = (el) => {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  };
  const findRow = (exactOnly) => {
    let contains = null;
    for (const el of chatRows()) {
      const name = rowName(el).toLowerCase();
      if (name.length === 0) continue;
      if (name === wanted) return el;
      if (contains == null && name.includes(wanted)) contains = el;
    }
    return exactOnly ? null : contains;
  };
  const direct = findRow(false);
  if (direct) return { ok: true, ...centre(direct) };

  // The search box has been an <input> and a contenteditable across builds;
  // type whichever exists, and VERIFY the text landed: a query that never
  // typed searches nothing and reads as "no such chat" for every chat
  // outside the rendered sidebar.
  let search = document.querySelector('[data-testid="chat-list-search-container"] input, #side input[role="textbox"]');
  let editable = null;
  if (!search) {
    editable = document.querySelector('#side [contenteditable="true"], [data-tab="3"][contenteditable="true"]');
    if (!editable) return { ok: false, error: 'Could not find the search box.' };
  }
  const typedOk = () => {
    const txt = search
      ? (search.value || '')
      : (editable.textContent || '');
    return txt.toLowerCase().includes(wanted.slice(0, 12));
  };
  if (search) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    search.focus();
    setter.call(search, target);
    search.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    editable.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, target);
  }
  await sleep(300);
  if (!typedOk()) {
    // Synthetic input ignored (a Lexical search box): hand the box's
    // position back so the caller can type through the real input pipeline
    // and re-run the row scan.
    const box = (search || editable).getBoundingClientRect();
    return {
      ok: false,
      needTrustedType: true,
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
    };
  }
  const end = Date.now() + 5000;
  let sample = [];
  while (Date.now() < end) {
    const hit = findRow(false);
    if (hit) return { ok: true, ...centre(hit) };
    sample = [...chatRows()].map(rowName).filter((n) => n.length > 0).slice(0, 6);
    await sleep(200);
  }
  return {
    ok: false,
    error: 'No WhatsApp chat matched "' + target + '"' +
      (sample.length ? ' (search showed: ' + sample.join(' | ').slice(0, 200) + ')' : ' (search showed no rows)'),
  };
`;

/** Re-scan search results for the target row after trusted typing. */
const FIND_ROW_AFTER_TYPE_SCRIPT = pageScript`
  ${HELPERS}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wanted = String(args.target || '').trim().toLowerCase();
  const centre = (el) => {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  };
  const end = Date.now() + 5000;
  let sample = [];
  while (Date.now() < end) {
    let contains = null;
    for (const el of chatRows()) {
      const name = rowName(el).toLowerCase();
      if (name.length === 0) continue;
      if (name === wanted) return { ok: true, ...centre(el) };
      if (contains == null && name.includes(wanted)) contains = el;
    }
    if (contains) return { ok: true, ...centre(contains) };
    sample = [...chatRows()].map(rowName).filter((n) => n.length > 0).slice(0, 6);
    await sleep(200);
  }
  return {
    ok: false,
    error: 'No WhatsApp chat matched "' + args.target + '"' +
      (sample.length ? ' (search showed: ' + sample.join(' | ').slice(0, 200) + ')' : ' (search showed no rows)'),
  };
`;

/** How long to let WhatsApp settle before asking for the message box again. */
const COMPOSER_RETRY_DELAY_MS = 2_000;

/** Whether a composer is on screen right now: the "still on that chat" check. */
const COMPOSER_PRESENT_SCRIPT = pageScript`
  return { ok: !!document.querySelector('footer [contenteditable="true"]') };
`;

/** After /send?phone=: the conversation (or WhatsApp's error) mounted. */
const NUMBER_OPEN_SETTLED_SCRIPT = pageScript`
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    if (document.querySelector('footer [contenteditable="true"]')) return { ok: true };
    // WhatsApp's own "phone number shared via url is invalid" dialog.
    const modal = document.querySelector('[data-animate-modal-popup="true"], div[aria-modal="true"]');
    if (modal && /invalid/i.test(modal.innerText || '')) return { ok: false };
    await sleep(300);
  }
  return { ok: false };
`;

/**
 * Does the OPEN conversation belong to the chat we asked for? A row click can
 * land on a different chat as the markup drifts, and a send typed into
 * whatever opened goes to the wrong human.
 */
const CHAT_MATCHES_SCRIPT = pageScript`
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const wanted = norm(args.name).slice(0, 24);
  const topBar = () => {
    const main = document.querySelector('#main');
    if (!main) return null;
    return main.querySelector('header') || main.firstElementChild;
  };
  const end = Date.now() + 5000;
  let text = '';
  while (Date.now() < end) {
    const bar = topBar();
    text = bar ? norm(bar.innerText) : '';
    if (text.length > 0) {
      // An empty wanted name means "just read the bar" (the self-chat title
      // lookup); any non-empty bar answers it.
      if (wanted.length === 0 || text.includes(wanted))
        return { ok: true, bar: text.slice(0, 60) };
    }
    await sleep(200);
  }
  return { ok: false, bar: text.slice(0, 60) };
`;

/** The open chat's composer position, ready for a trusted click + paste. */
const COMPOSER_SCRIPT = pageScript`
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    const box = document.querySelector('footer [contenteditable="true"]');
    if (box) {
      const r = box.getBoundingClientRect();
      return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }
    await sleep(150);
  }
  return { ok: false, error: 'The message box did not open.' };
`;

/**
 * Whether the text just sent is now an OUTGOING BUBBLE in the open chat: the
 * read-back that makes a send a fact, since an empty composer proves nothing.
 */
const SENT_VERIFY_SCRIPT = pageScript`
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Doubled backslashes, as everywhere in these scripts.
  const norm = (s) => (s || '').replace(/[\\u200B\\uFEFF]/g, '').replace(/\\s+/g, ' ').trim();
  const head = norm(args.head);
  if (head.length === 0) return { ok: true };
  const main = document.querySelector('#main');
  if (!main) return { ok: false, error: 'no open chat' };
  const mainRect = main.getBoundingClientRect();
  const midline = mainRect.x + mainRect.width / 2;
  // The testid and the legacy classes have both been seen absent in the
  // field: a verify that cannot see ANY bubbles fails a send that worked,
  // and the resend it provokes duplicates the message. Message rows are the
  // fallback: they exist as long as the conversation renders at all.
  const allBubbles = () => {
    const primary = [...document.querySelectorAll('#main [data-testid="msg-container"], #main .message-in, #main .message-out')];
    if (primary.length > 0) return primary;
    return [...document.querySelectorAll('#main [role="row"]')];
  };
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const bubbles = allBubbles();
    // A NEW bubble must exist. Without this, an older message with similar
    // text vouched for a send that never happened: a chat full of test
    // jokes always has a bubble that matches "here's a joke".
    if (args.priorCount >= 0 && bubbles.length <= args.priorCount) {
      await sleep(250);
      continue;
    }
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      const r = b.getBoundingClientRect();
      const isOut = b.classList.contains('message-out') ||
        (!b.classList.contains('message-in') && r.x + r.width / 2 > midline);
      if (!isOut) continue;
      // Only the LAST outgoing bubble answers.
      if (!norm(b.innerText).includes(head)) break;
      // The bubble exists. Now demand the server's tick. A half-dead web
      // session renders the bubble with a pending clock and never delivers
      // it; that message exists only on this screen, and reporting it sent
      // is exactly the lie this read-back exists to prevent.
      if (b.querySelector('[data-icon="msg-check"], [data-icon="msg-dblcheck"], [data-icon="msg-dblcheck-ack"]'))
        return { ok: true };
      if (!b.querySelector('[data-icon="msg-time"]'))
        // No status icon at all: the markup changed. Bubble presence is the
        // best evidence left, so take it rather than failing every send.
        return { ok: true };
      break;
    }
    await sleep(250);
  }
  const last = allBubbles().at(-1);
  const pending = last && last.querySelector('[data-icon="msg-time"]');
  return {
    ok: false,
    error: pending
      ? 'the message is stuck pending and never reached WhatsApp'
      : 'no new outgoing bubble with the sent text',
  };
`;

/** How many bubbles the open chat shows: the read-back's "new" baseline. */
const BUBBLE_COUNT_SCRIPT = pageScript`
  const primary = document.querySelectorAll('#main [data-testid="msg-container"], #main .message-in, #main .message-out').length;
  return { bubbles: primary > 0 ? primary : document.querySelectorAll('#main [role="row"]').length };
`;

/** How many outgoing bubbles already carry the text: the pre-send baseline. */
const MATCHING_OUT_COUNT_SCRIPT = pageScript`
  const norm = (s) => (s || '').replace(/[\\u200B\\uFEFF]/g, '').replace(/\\s+/g, ' ').trim();
  const head = norm(args.head);
  if (head.length === 0) return { count: 0 };
  const main = document.querySelector('#main');
  if (!main) return { count: 0 };
  const midline = main.getBoundingClientRect().x + main.getBoundingClientRect().width / 2;
  let bubbles = [...main.querySelectorAll('[data-testid="msg-container"], .message-in, .message-out')];
  if (!bubbles.length) bubbles = [...main.querySelectorAll('[role="row"]')];
  let count = 0;
  for (const b of bubbles) {
    const r = b.getBoundingClientRect();
    const isOut = b.classList.contains('message-out') ||
      (!b.classList.contains('message-in') && r.x + r.width / 2 > midline);
    if (isOut && norm(b.innerText).includes(head)) count += 1;
  }
  return { count };
`;

/** Is the sent text among the chat's RECENT outgoing bubbles: the post-heal
 * check between "landed after all" and "resend". Wider than the last bubble
 * on purpose, since other messages may have arrived since. */
const RECENT_OUT_SCRIPT = pageScript`
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/[\\u200B\\uFEFF]/g, '').replace(/\\s+/g, ' ').trim();
  const head = norm(args.head);
  if (head.length === 0) return { found: true };
  const prior = Number(args.priorMatches) || 0;
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const main = document.querySelector('#main');
    if (main) {
      const mainRect = main.getBoundingClientRect();
      const midline = mainRect.x + mainRect.width / 2;
      let bubbles = [...document.querySelectorAll('#main [data-testid="msg-container"], #main .message-in, #main .message-out')];
      if (!bubbles.length) bubbles = [...document.querySelectorAll('#main [role="row"]')];
      let matches = 0;
      for (const b of bubbles) {
        const r = b.getBoundingClientRect();
        const isOut = b.classList.contains('message-out') ||
          (!b.classList.contains('message-in') && r.x + r.width / 2 > midline);
        if (isOut && norm(b.innerText).includes(head)) matches += 1;
      }
      // A NEW matching bubble, not merely one that was already there: the
      // self-chat holds a "hi" from days ago, and matching that called every
      // "hi" delivered while nothing new went out. Landed = more matches
      // than before the send.
      if (matches > prior) return { found: true };
      // No early "absent": a chat fresh off a renderer heal hydrates oldest
      // first, so the count climbs as it renders. Only the deadline can
      // conclude nothing new arrived.
    }
    await sleep(300);
  }
  return { found: false };
`;

/** The composer's send button, which works whatever the "Enter is send"
 * setting says. Icon names drift, so match on the prefix inside the footer. */
const SEND_BUTTON_SCRIPT = pageScript`
  const footer = document.querySelector('#main footer');
  if (!footer) return { ok: false };
  const icon = footer.querySelector('[data-icon="send"], [data-icon^="wds-ic-send"], button[aria-label] span[data-icon*="send"]');
  const target = icon ? icon.closest('button') || icon : null;
  if (!target) return { ok: false };
  const r = target.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { ok: false };
  return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
`;

/** Whether the composer is empty: a fast pre-check before the read-back. */
const COMPOSER_EMPTY_SCRIPT = pageScript`
  const box = document.querySelector('footer [contenteditable="true"]');
  if (!box) return { empty: true };
  // Doubled backslashes: written singly, TypeScript would eat the escapes and
  // the page would receive a regex stripping the letter "s". See the Discord
  // connector's identical note.
  return { empty: box.textContent.replace(/[\\u200B\\uFEFF\\s]/g, '').length === 0 };
`;

/**
 * Read the open chat's recent bubbles. `data-pre-plain-text` carries author
 * and time; direction is geometric, since the right-aligned layout is the
 * product and does not churn the way class names do.
 */
const READ_CHAT_SCRIPT = pageScript`
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const limit = Number(args.limit) || 30;
  const t0 = Date.now();
  let bubbles = [];
  while (Date.now() - t0 < 6000) {
    bubbles = [...document.querySelectorAll('#main [data-testid="msg-container"], #main .message-in, #main .message-out')];
    // The testid and the legacy classes have both been seen absent in the
    // field. The send verifier learned this first; a reader without the
    // same fallback answered "0 messages" for every chat on those builds.
    if (!bubbles.length)
      bubbles = [...document.querySelectorAll('#main [role="row"]')];
    if (bubbles.length) break;
    await sleep(150);
  }
  const main = document.querySelector('#main');
  const mainRect = main ? main.getBoundingClientRect() : { x: 0, width: window.innerWidth };
  const midline = mainRect.x + mainRect.width / 2;
  // WhatsApp renders every emoji as an <img alt="…">, so textContent drops
  // them: a 👍-only reply read as an empty bubble, fell through to the
  // innerText fallback below, and came back as its own time label. The
  // agent reported "9:30 pm" as the message. Read text with the alt texts
  // put back in their place.
  const withEmoji = (el) => {
    if (!el) return '';
    const clone = el.cloneNode(true);
    for (const img of clone.querySelectorAll('img[alt]'))
      img.replaceWith(img.getAttribute('alt'));
    return (clone.textContent || '').replace(/\\s+/g, ' ').trim();
  };
  const out = [];
  for (const b of bubbles.slice(-limit)) {
    const textEl = b.querySelector('span.selectable-text, .selectable-text');
    let text = withEmoji(textEl);
    if (text.length === 0) {
      // Business and template bubbles (boarding passes, fund statements,
      // list messages, image captions) carry no .selectable-text, and
      // skipping them read whole business chats as empty. Take the bubble's
      // rendered text instead: noisier (a trailing time, button labels), but
      // a message the user can see must never be one the agent cannot.
      text = withEmoji(b).slice(0, 2000);
      // What is left of a pure media bubble is just its own time label;
      // name the message for what it is rather than parroting the clock.
      if (/^\\d{1,2}:\\d{2}(\\s?(am|pm))?$/i.test(text)) text = '[media message]';
    }
    if (text.length === 0) continue;
    const meta = b.querySelector('[data-pre-plain-text]');
    const pre = meta ? meta.getAttribute('data-pre-plain-text') : '';
    const m = pre.match(/^\\[(.+?)\\]\\s*(.*?):\\s*$/);
    // In "[7:23 pm, 5/10/2026] Name:" the date is in the ACCOUNT's locale
    // order, day-first for most of the world, and new Date() reads bare
    // slashes month-first: 5/10 became October 5th, 31/8 didn't parse at
    // all and fell back to "now". The agent then reported messages from
    // phantom future dates and called today's history ambiguous. Parse the
    // fields by hand: a value over 12 settles which one is the day, and an
    // ambiguous pair is day-first unless that puts the message in the
    // future. Messages cannot be from tomorrow.
    let at = null;
    if (m) {
      const t = m[1].match(/(\\d{1,2}):(\\d{2})\\s*([ap]m)?\\s*,\\s*(\\d{1,2})\\/(\\d{1,2})\\/(\\d{2,4})/i);
      if (t) {
        let hour = Number(t[1]);
        const ampm = (t[3] || '').toLowerCase();
        if (ampm === 'pm' && hour < 12) hour += 12;
        if (ampm === 'am' && hour === 12) hour = 0;
        const a = Number(t[4]), b = Number(t[5]);
        let year = Number(t[6]);
        if (year < 100) year += 2000;
        let day = a, month = b;
        if (a <= 12 && b > 12) { day = b; month = a; }
        else if (a <= 12 && b <= 12) {
          const dayFirst = new Date(year, b - 1, a, hour, Number(t[2]));
          if (dayFirst.getTime() - Date.now() > 86400000) { day = b; month = a; }
        }
        const parsed = new Date(year, month - 1, day, hour, Number(t[2]));
        if (!isNaN(parsed.getTime())) at = parsed.toISOString();
      }
    }
    if (at == null) at = new Date().toISOString();
    const r = b.getBoundingClientRect();
    const direction = b.classList.contains('message-out') ||
      (!b.classList.contains('message-in') && r.x + r.width / 2 > midline)
        ? 'out' : 'in';
    out.push({ userName: m && m[2] ? m[2] : null, text, direction, at });
  }
  return out;
`;

/**
 * Content search via WhatsApp's own search box; only the Messages section of
 * the results is content. The box is CLEARED before returning: search mode
 * takes the chat list, the login probe's evidence, off the DOM.
 */
const SEARCH_MESSAGES_SCRIPT = pageScript`
  ${HELPERS}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const query = String(args.query || '').trim();
  const limit = Number(args.limit) || 10;
  if (query.length === 0) return [];
  const search = document.querySelector('[data-testid="chat-list-search-container"] input, #side input[role="textbox"]');
  if (!search) return null;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  const type = (value) => {
    search.focus();
    setter.call(search, value);
    search.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const collect = () => {
    const out = [];
    let section = '';
    for (const el of chatRows()) {
      const label = (el.innerText || '').trim();
      if (/^(chats|contacts|messages|groups)$/i.test(label)) {
        section = label.toLowerCase();
        continue;
      }
      if (section !== 'messages') continue;
      const name = rowName(el);
      const snippetEl =
        el.querySelector('[data-testid="cell-frame-secondary"]') ??
        el.querySelectorAll('span[title]')[1];
      const snippet = (snippetEl ? snippetEl.textContent : '').trim();
      const whenEl = el.querySelector('[data-testid="cell-frame-primary-detail"]');
      const when = (whenEl ? whenEl.textContent : '').trim();
      if (name.length === 0 || snippet.length === 0) continue;
      out.push({ chatId: name, name, snippet, when });
      if (out.length >= limit) break;
    }
    return out;
  };
  try {
    type(query);
    const end = Date.now() + 6000;
    let rows = [];
    while (Date.now() < end) {
      rows = collect();
      if (rows.length > 0) break;
      await sleep(300);
    }
    return rows;
  } finally {
    type('');
    search.blur();
  }
`;

/** The footer's attach control, under every name it has worn. */
const ATTACH_BUTTON_SCRIPT = pageScript`
  const el = document.querySelector(
    'footer [data-testid="attach-menu-plus"], footer [data-icon="plus"], footer [data-icon="attach-menu-plus"], footer [data-icon="clip"], footer button[title*="Attach" i], footer [aria-label*="Attach" i]'
  );
  if (!el) return { ok: false, error: 'No attach button in the composer.' };
  const r = el.getBoundingClientRect();
  return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
`;

/** Whether the media-preview overlay (caption box + its own send) is up. */
const MEDIA_PREVIEW_OPEN_SCRIPT = pageScript`
  return { open: !!document.querySelector('[data-testid="media-caption-input-container"], [data-animate-modal-body] [data-icon="send"], div[aria-label*="caption" i]') };
`;
