import { randomBytes } from "node:crypto";

import { BrowserWindow } from "electron";

import type { MessagingPlatformId } from "#shared/messaging";

import {
  bringToFront,
  dismissOnEscape,
  parentWindow,
  presentAsDialog,
} from "../../bring-to-front";
import {
  chunkMessage,
  isEphemeralPreview,
  previewMatchesSent,
  normalizeScrapedText,
  type ConnectorCallbacks,
  type MessagingConnector,
  saveInboundMedia,
  type InboundMessage,
} from "./connector";
import { readFieldValue } from "./messaging-config-service";
import {
  BOT_MAX_MESSAGE_LENGTH,
  botUsernameCandidate,
  isUsernameRejected,
  parseBotFatherToken,
  readTelegramBotState,
  resolveBotToken,
  saveTelegramBotState,
  TelegramBotPoller,
  type BotInbound,
  type TelegramBotState,
} from "./telegram-bot-identity";

/**
 * Telegram, by driving the real web.telegram.org in a hidden BrowserWindow:
 * the user signs in to Telegram's own web app and the agent drives the
 * logged-in page to send and read; the session persists in its own partition.
 * A Bot API bot, self-provisioned through BotFather over this same session,
 * rides on top as the assistant's voice to "me" and to anyone who messaged
 * it. The driver scripts' DOM selectors are the brittle part.
 */

const TELEGRAM_WEB_URL = "https://web.telegram.org/k/";

/**
 * Self-link retry pacing: every 15s while Telegram's resolver propagates a
 * just-created username, then a steady five minutes forever. Safe to repeat
 * forever because a failed attempt has no user-visible effect (see linkSelf).
 */
const LINK_RETRY_FAST_MS = 15_000;
const LINK_RETRY_FAST_ATTEMPTS = 40;
const LINK_RETRY_STEADY_MS = 5 * 60_000;

const LINK_NONCE_TTL_MS = 24 * 60 * 60 * 1000;

/** Holds the login; survives restarts, cleared on disconnect. */
const TELEGRAM_PARTITION = "persist:telegram-web";

/** Telegram's message cap, kept a little under. */
const MAX_MESSAGE_LENGTH = 4000;

const LOGIN_POLL_MS = 1500;

const INBOUND_POLL_MS = 5000;

type LoginState = {
  loggedIn: boolean;
  loginVisible?: boolean;
  /** A refusal the login page itself is showing (rate limits, mostly). */
  loginError?: string | null;
};

export class TelegramWebConnector implements MessagingConnector {
  readonly id: MessagingPlatformId = "telegram";

  private window: BrowserWindow | null = null;
  private running = false;
  private loggedIn = false;
  /** Consecutive signed-out polls after a login — see checkLogin. */
  private signedOutTicks = 0;
  private loginTimer: NodeJS.Timeout | null = null;
  private inboundTimer: NodeJS.Timeout | null = null;
  private contacts: Array<{ chatId: string; name: string }> = [];
  /** Chat id -> the last inbound message id we already reported, for dedupe. */
  private lastSeen = new Map<string, string>();
  /** Chat id -> recent texts we sent there; the sweep skips our own echoes. */
  private lastSentTexts = new Map<string, string[]>();

  /** The last few outbound texts per chat: every chunk of a multi-message
   * reply must be guarded against echoing back, not just the last. */
  private rememberSent(chatId: string, text: string): void {
    const ring = this.lastSentTexts.get(chatId) ?? [];
    ring.push(text);
    if (ring.length > 5) ring.shift();
    this.lastSentTexts.set(chatId, ring);
  }
  private firstInboundSweep = true;

  private botPoller: TelegramBotPoller | null = null;
  private botState: TelegramBotState = {};
  /** Guards ensureBotIdentity against overlapping login-poll ticks. */
  private botStarting = false;
  /** Provisioning attempts that failed; retried from the sweep, bounded. */
  private provisionFailures = 0;
  private nextProvisionAttempt = 0;
  /** The creation rate limit already told the user, with the wait time. */
  private provisionCapReported = false;
  /** Chats that reached us through the bot; the account has no conversation
   * with them, so replies must never fall through to the web sender. */
  private readonly botChats = new Set<string>();
  private nextLinkAttempt = 0;
  /** Automatic link attempts so far; picks the retry pace. */
  private linkAttempts = 0;
  /** The pending link nonce; a /start carrying it proves "me". */
  private linkNonce: { value: string; expiresAt: number } | null = null;
  constructor(private readonly callbacks: ConnectorCallbacks) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.callbacks.onState("connecting");

    // Hidden: launching must never throw Telegram Web in the user's face; the
    // connect dialog reveals it. Its own window rather than the app's
    // WebContentsView runtime, which dies on renderer navigation.
    this.window = new BrowserWindow({
      show: false,
      width: 960,
      height: 720,
      title: "Log in to Telegram",
      // A child of the app window so it shares the app's Space; top-level, a
      // full-screen app left it hidden on an empty Space of its own.
      ...(parentWindow() != null ? { parent: parentWindow() } : {}),
      // Not modal (a native macOS sheet the app does not survive), frameless
      // everywhere. Esc, Cmd/Ctrl+W and the injected Cancel pill are the exit.
      autoHideMenuBar: true,
      frame: false,
      // Painted and unthrottled while hidden: the driver clicks at element
      // coordinates and waits on web-k's chat mount, both stall when throttled.
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition: TELEGRAM_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

    // Muted: a hidden page still plays the web app's new-message sound.
    this.window.webContents.setAudioMuted(true);
    // Gone entirely, not just auto-hidden: Alt would bring it back. Windows
    // and Linux only — macOS has no per-window menu, and no removeMenu.
    if (process.platform !== "darwin") this.window.removeMenu();
    // No close button of its own: Esc and the injected pill are the way out.
    dismissOnEscape(this.window);
    // Closing the window does not disable the platform: drop the handle and
    // let ensureWindow reopen it on the next sweep or send.
    this.window.on("closed", () => {
      this.window = null;
    });

    try {
      await this.window.loadURL(TELEGRAM_WEB_URL);
    } catch (error) {
      // Worth reporting; the poll below still runs in case the page recovers.
      this.callbacks.onLog(
        `telegram-web: initial load failed: ${String((error as Error)?.message ?? error)}`
      );
    }

    if (!this.running) return;
    this.pollLogin();
    void this.checkLogin();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.loggedIn = false;
    if (this.loginTimer != null) clearInterval(this.loginTimer);
    if (this.inboundTimer != null) clearInterval(this.inboundTimer);
    this.loginTimer = null;
    this.inboundTimer = null;
    this.botPoller?.stop();
    this.botPoller = null;
    const win = this.window;
    this.window = null;
    if (win != null && !win.isDestroyed()) win.destroy();
    this.callbacks.onState("disabled");
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.loggedIn)
      throw new Error(
        "Telegram is not logged in yet — finish signing in first."
      );

    // The bot's chats are the bot's to answer: "me" (so it arrives from
    // AbacusAI Bot, not as a note to self) and anyone who messaged the bot.
    const target = chatId.trim();
    if (
      this.botPoller != null &&
      (target === this.botState.selfChatId || this.botChats.has(target))
    ) {
      for (const chunk of chunkMessage(text, BOT_MAX_MESSAGE_LENGTH)) {
        await this.botPoller.sendMessage(target, chunk);
        this.rememberSent(target, chunk);
      }
      return;
    }

    // The same verified script BotFather provisioning uses: typing confirmed
    // in the composer, the message confirmed as a new outgoing bubble.
    for (const chunk of chunkMessage(text, MAX_MESSAGE_LENGTH)) {
      const attempt = async (): Promise<{
        ok: boolean;
        error?: string;
      } | null> =>
        this.run<{ ok: boolean; error?: string }>(TALK_SCRIPT, {
          target,
          requirePeerId: /^-?\d+$/.test(target) ? target : "",
          text: chunk,
          waitReplyMs: 0,
        });
      let result = await attempt();
      if (
        result?.ok !== true &&
        // Every TALK failure but "did not appear" proves nothing was sent, so
        // a reload and one retry is duplicate-safe; that one may have gone out.
        !(result?.error ?? "").includes("did not appear")
      ) {
        // A long-open page goes stale, web-k ignoring input, until reloaded.
        this.callbacks.onLog(
          `telegram-web: send failed on a possibly stale page (${result?.error ?? "no result"}) — reloading and retrying`
        );
        this.botFatherOpen = false;
        const win = this.recreateWindow();
        if (win != null && !win.isDestroyed()) {
          await win.loadURL(TELEGRAM_WEB_URL).catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 4_000));
        }
        result = await attempt();
      }
      if (result?.ok !== true) {
        throw new Error(
          result?.error ?? `Could not send the Telegram message to ${chatId}.`
        );
      }
      // The last chunk is what the dialog-list preview will show; the sweep
      // compares against it to keep our own reply from reading as inbound.
      this.rememberSent(target, chunk);
    }
  }

  listContacts(): Array<{ chatId: string; name: string }> {
    return this.contacts;
  }

  /**
   * Open a chat and read its recent messages, not just what the sweep caught.
   * Only numeric peer ids can be opened directly; an unresolved name has none.
   */
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
    if (!/^-?\d+$/.test(chatId.trim())) return [];
    const rows = await this.run<
      Array<{ direction: "in" | "out"; text: string; at: string }>
    >(READ_CHAT_SCRIPT, { target: chatId.trim(), limit });
    if (rows == null) return [];
    const name =
      this.contacts.find((c) => c.chatId === chatId.trim())?.name ?? null;
    return rows.map((row) => ({
      userName: row.direction === "out" ? null : name,
      text: row.text,
      direction: row.direction,
      at: row.at,
    }));
  }

  // ── Login ──────────────────────────────────────────────────────────────

  private pollLogin(): void {
    if (this.loginTimer != null) clearInterval(this.loginTimer);
    this.loginTimer = setInterval(() => void this.checkLogin(), LOGIN_POLL_MS);
  }

  /** Consecutive login polls the page failed to answer — see checkLogin. */
  private notReadyTicks = 0;

  /** See MessagingConnector.probeLive: one login check now, then the answer. */
  async probeLive(): Promise<boolean> {
    if (!this.running) return false;
    try {
      await this.checkLogin();
    } catch {
      // A page that cannot be read right now leaves the last verdict standing.
    }
    return this.loggedIn;
  }

  private async checkLogin(): Promise<void> {
    if (!this.running) return;
    const state = await this.run<LoginState>(LOGIN_STATE_SCRIPT, {});
    if (state == null) {
      // A page that never answers is not "still loading" forever: a failed
      // initial load leaves a dead page whose QR can never complete. Reload.
      this.notReadyTicks += 1;
      if (this.notReadyTicks >= 8) {
        this.notReadyTicks = 0;
        this.callbacks.onLog(
          "telegram-web: the page never became ready — reloading it"
        );
        const win = this.ensureWindow();
        if (win != null && !win.isDestroyed())
          void win.loadURL(TELEGRAM_WEB_URL).catch(() => {});
      }
      return;
    }
    // Neither login page nor chat UI: the page has not booted, and judging it
    // would flip the card on nothing. Not-ready, so the reload above fixes it.
    if (!state.loggedIn && state.loginVisible !== true) {
      this.notReadyTicks += 1;
      if (this.notReadyTicks >= 8) {
        this.notReadyTicks = 0;
        this.callbacks.onLog(
          "telegram-web: page is neither signed in nor showing a login — reloading it"
        );
        const win = this.ensureWindow();
        if (win != null && !win.isDestroyed())
          void win.loadURL(TELEGRAM_WEB_URL).catch(() => {});
      }
      return;
    }
    this.notReadyTicks = 0;

    if (state.loggedIn) this.signedOutTicks = 0;

    if (state.loggedIn && !this.loggedIn) {
      this.loggedIn = true;
      // Hide rather than close: the page is the session every send drives.
      const win = this.window;
      if (win != null && !win.isDestroyed() && win.isVisible()) {
        win.hide();
        // Put the app in front, not whatever the OS picks after a hide.
        bringToFront();
      }
      this.callbacks.onState("connected");
      // The login poll keeps running after connect; it is what notices a
      // session removed from the phone.
      this.startInboundPolling();
      void this.refreshContacts();
      // Provisioning talks to BotFather through this session, so after login.
      void this.ensureBotIdentity();
      return;
    }

    // A login screen means there is no session: a wait on a human, not a
    // failure, so `needs_login` keeps the gateway from restarting us. The
    // window is only ever shown by the connect dialog, never from here.
    if (!state.loggedIn && !this.loggedIn && state.loginVisible === true) {
      this.callbacks.onState(
        state.loginError != null ? "rate_limited" : "needs_login",
        state.loginError != null
          ? `Telegram is refusing sign-ins right now — its login page says: "${state.loginError}". ` +
              "This is Telegram rate-limiting login attempts; wait a while " +
              "before trying the QR again."
          : "Telegram is not signed in. Scan the QR from your phone to connect."
      );
      return;
    }

    if (!state.loggedIn && this.loggedIn) {
      // Two consecutive polls, not one: a page mid-reload can briefly read as
      // signed out, and a false flap tells every conversation we vanished.
      this.signedOutTicks += 1;
      if (this.signedOutTicks < 2) return;
      this.signedOutTicks = 0;
      // Signed out elsewhere, or expired: the session ended, not "connecting".
      this.loggedIn = false;
      // The bot lane goes down with the login: the next sign-in may be a
      // different person, and ensureBotIdentity's who-is-"me" check only
      // runs when the poller comes back up.
      this.botPoller?.stop();
      this.botPoller = null;
      this.callbacks.onState(
        "needs_login",
        "Telegram is signed out — the session was ended from another device or expired. Reconnect to sign in again."
      );
      this.pollLogin();
    }
  }

  /** Bring the login window back to the front (re-scan, or first login). */
  showLoginWindow(): void {
    const win = this.ensureWindow();
    if (win == null) return;
    // The whole reveal lives there, including leaving macOS full screen first.
    presentAsDialog(win);
  }

  /** True once the user has signed in — surfaced to the connect dialog. */
  get isLoggedIn(): boolean {
    return this.loggedIn;
  }

  /** Session up, bot not linked yet — the dialog shows "still setting up". */
  botSetupPending(): boolean {
    // Not "pending" once provisioning has failed out, or the pane would say
    // "Linking…" forever; that case reports itself as an error.
    if (this.botPoller == null && this.provisionFailures >= 3) return false;
    return this.loggedIn && this.botState.selfChatId == null;
  }

  /** The user's chat with the bot — what "send this to me" resolves to. */
  selfChatId(): string | null {
    return this.botState.selfChatId ?? null;
  }

  // ── Bot identity ───────────────────────────────────────────────────────

  /**
   * Bring the bot online: reuse the stored token or mint one through
   * BotFather, then make sure we know which chat is "me". Every failure is
   * logged and non-fatal; the account session keeps working without the bot.
   */
  private async ensureBotIdentity(): Promise<void> {
    if (this.botPoller != null || this.botStarting) return;
    this.botStarting = true;
    try {
      this.botState = readTelegramBotState();
      // A token pasted into the dialog (or the environment) beats the minted
      // one: the escape hatch for a failed BotFather conversation.
      let token =
        readFieldValue("telegram", "TELEGRAM_BOT_TOKEN") ??
        resolveBotToken(this.botState);
      if (token == null) {
        token = await this.provisionBot();
        if (token == null) {
          // Three tries, then tell the user what to do, or the pane would say
          // "Linking…" forever. A creation rate limit already reported itself
          // with the wait time; the generic message must not overwrite it.
          this.provisionFailures += 1;
          this.nextProvisionAttempt = Date.now() + 3 * 60_000;
          if (this.provisionFailures >= 3 && !this.provisionCapReported)
            this.callbacks.onState(
              "error",
              "Telegram is signed in, but creating your AbacusAI assistant " +
                "bot kept failing (the BotFather conversation did not go " +
                "through). Reconnect to try again — or open the dialog's " +
                "Advanced section and paste a bot token from @BotFather."
            );
          return;
        }
        this.provisionFailures = 0;
      }

      const poller = new TelegramBotPoller(token, {
        onMessage: (message) => this.handleBotInbound(message),
        onLog: (line) => this.callbacks.onLog(line),
      });
      try {
        const me = await poller.getMe();
        if (this.botState.username !== me.username)
          this.botState = saveTelegramBotState({ username: me.username });
      } catch (error) {
        this.callbacks.onLog(
          `telegram-bot: token rejected (${String((error as Error)?.message ?? error)}) — forgetting it and re-provisioning`
        );
        // A dead token (revoked, or stale from BotFather's history) must not
        // wedge the bot lane until a restart: forget it and re-provision.
        this.botState = saveTelegramBotState({ token: "" });
        this.provisionFailures = Math.max(1, this.provisionFailures);
        this.nextProvisionAttempt = Date.now() + 30_000;
        return;
      }
      if (!this.running || !this.loggedIn) return;

      poller.start();
      this.botPoller = poller;
      this.callbacks.onLog(`telegram-bot: @${this.botState.username} online`);

      if (this.botState.selfChatId == null) await this.linkSelf();
      else {
        // A restored "me" must match the signed-in account (a private bot
        // chat's id is the account's own user id), or "send me X" is acked into
        // someone else's chat. Mismatch means relink to whoever is signed in.
        const account = await this.run<{ id: string | null }>(
          ACCOUNT_ID_SCRIPT,
          {}
        );
        const accountId = account?.id ?? null;
        if (accountId != null && accountId !== this.botState.selfChatId) {
          this.callbacks.onLog(
            `telegram-web: the signed-in account (…${accountId.slice(-4)}) ` +
              `is not the one "me" was linked to (…${this.botState.selfChatId.slice(-4)}) — ` +
              "relinking so sends reach the account that is actually here"
          );
          this.botState = saveTelegramBotState({ selfChatId: undefined });
          await this.linkSelf();
        }
        // A link restored from disk is as linked as a fresh one — the
        // once-ever auto-reply bootstrap must fire for existing users too.
        else this.callbacks.onSelfLinked?.();
      }
    } finally {
      this.botStarting = false;
    }
  }

  /**
   * Mint the bot through BotFather as a person would: `/newbot`, a display
   * name, then username candidates until one is free. The chat is opened by
   * BotFather's known peer id, never global search, so no look-alike gets it.
   */
  private async provisionBot(): Promise<string | null> {
    const fail = (step: string, reply: string | null | undefined): null => {
      this.callbacks.onLog(
        `telegram-bot: provisioning failed at ${step}${reply != null ? `: ${reply.slice(0, 120)}` : ""}`
      );
      return null;
    };

    // BotFather's command-menu greeting can land in the reply slot we wait on,
    // putting later answers one step behind; then start over once from /newbot.
    const isIntro = (reply: string | null): boolean =>
      reply != null && /create and manage Telegram bots/i.test(reply);

    // BotFather caps bot creation per account ("too many attempts, try again in
    // N seconds", N seen at fifteen hours): report the wait, do not retry.
    const capSeconds = (reply: string | null): number | null => {
      const m =
        reply == null
          ? null
          : /too many attempts.*?(\d+)\s*seconds/i.exec(reply);
      return m ? Number(m[1]) : null;
    };

    // A retry provisions from a fresh renderer: the intro-menu misalignment
    // persists on a degraded page and clears with a new one.
    if (this.provisionFailures > 0) {
      this.callbacks.onLog(
        "telegram-bot: fresh renderer for the provisioning retry"
      );
      this.botFatherOpen = false;
      const win = this.recreateWindow();
      if (win != null)
        await new Promise((resolve) => setTimeout(resolve, 4_000));
    }

    // First choice: a bot this account already owns. BotFather's history holds
    // every "Done!" message with its token, and an existing bot links at once.
    if (
      await this.openByDeepLink("botfather", {
        expectedHashes: ["#@botfather"],
      }).then((r) => r.ok)
    ) {
      this.botFatherOpen = true;
      const found = await this.run<{
        token: string | null;
        pages?: number;
        bubbles?: number;
      }>(BOTFATHER_HISTORY_SCRIPT, {});
      this.callbacks.onLog(
        `telegram-bot: history scan ${found?.token != null ? "found a token" : "found none"} ` +
          `(scrolled ${found?.pages ?? "?"} pages, ${found?.bubbles ?? "?"} bubbles rendered)`
      );
      if (found?.token != null) {
        // getMe says whose token this is; only our own bots are adopted.
        try {
          const probe = new TelegramBotPoller(found.token, {
            onMessage: () => {},
            onLog: () => {},
          });
          const me = await probe.getMe();
          if (/^AbacusAI\w*Bot$/i.test(me.username)) {
            this.callbacks.onLog(
              `telegram-bot: reusing @${me.username} from BotFather's history`
            );
            this.botState = saveTelegramBotState({
              token: found.token,
              username: me.username,
            });
            return found.token;
          }
          this.callbacks.onLog(
            `telegram-bot: newest token in history belongs to @${me.username} — not ours, ignoring`
          );
        } catch {
          this.callbacks.onLog(
            "telegram-bot: newest token in history is dead — continuing"
          );
        }
      }
    }

    let first = await this.talkBotFather("/newbot");
    if (isIntro(first)) first = await this.talkBotFather("/newbot");
    const cap = capSeconds(first);
    if (cap != null) {
      const hours = Math.ceil(cap / 3600);
      this.provisionFailures = 3;
      this.provisionCapReported = true;
      this.callbacks.onState(
        "rate_limited",
        `Telegram is limiting bot creation for this account — BotFather says ` +
          `to try again in about ${hours} hour${hours === 1 ? "" : "s"}. ` +
          "An existing bot will be reused automatically if one is found in " +
          "BotFather's history; or paste a bot token under Advanced."
      );
      return fail("/newbot (creation rate limit)", first);
    }
    if (first == null) return fail("/newbot", first);

    let second = await this.talkBotFather("AbacusAI Bot");
    if (isIntro(second)) {
      const restart = await this.talkBotFather("/newbot");
      if (restart == null) return fail("/newbot", restart);
      second = await this.talkBotFather("AbacusAI Bot");
    }
    if (second == null) return fail("name", second);
    // Whether BotFather answered the name prompt or (stale /newbot in flight)
    // skipped ahead, the next thing it wants is the username.

    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = botUsernameCandidate();
      let reply = await this.talkBotFather(candidate);
      if (isIntro(reply)) {
        // Out of sync at the last step: restart and replay up to here.
        if ((await this.talkBotFather("/newbot")) == null)
          return fail("/newbot", null);
        if ((await this.talkBotFather("AbacusAI Bot")) == null)
          return fail("name", null);
        reply = await this.talkBotFather(candidate);
      }
      if (reply == null) return fail("username", reply);
      const token = parseBotFatherToken(reply);
      if (token != null) {
        this.botState = saveTelegramBotState({ token, username: candidate });
        this.callbacks.onLog(`telegram-bot: created @${candidate}`);
        return token;
      }
      if (!isUsernameRejected(reply)) return fail("username", reply);
    }
    return fail("username", "all candidates rejected");
  }

  /** True while the page is parked on the BotFather chat. */
  private botFatherOpen = false;

  /** A click through Chromium's real input pipeline; web-k's search UI
   * ignores synthetic MouseEvents. */
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

  /**
   * The resolver-independent road to the bot's chat: type the username into
   * web-k's search with trusted input and click the row carrying the exact
   * @username. tg://resolve can keep failing for minutes after t.me answers
   * (the failed lookup is cached); search rides a different server call.
   */
  private async openBySearch(
    username: string
  ): Promise<{ ok: boolean; error?: string }> {
    const win = this.ensureWindow();
    if (win == null || win.isDestroyed())
      return { ok: false, error: "no window" };

    const box = await this.run<{
      ok: boolean;
      error?: string;
      x?: number;
      y?: number;
    }>(SEARCH_BOX_SCRIPT, {});
    if (box?.ok !== true || box.x == null || box.y == null)
      return { ok: false, error: box?.error ?? "no search box" };

    this.trustedClick(win, box.x, box.y);
    await new Promise((resolve) => setTimeout(resolve, 300));
    win.webContents.insertText(username);

    const row = await this.run<{
      ok: boolean;
      error?: string;
      x?: number;
      y?: number;
    }>(SEARCH_RESULT_SCRIPT, { username });
    if (row?.ok !== true || row.x == null || row.y == null)
      return { ok: false, error: row?.error ?? "no result row" };

    this.trustedClick(win, row.x, row.y);
    await new Promise((resolve) => setTimeout(resolve, 600));
    return { ok: true };
  }

  /**
   * Open a chat by a `tg://resolve` deep link, as a hash change on the running
   * page: web-k acts on `#?tgaddr=` only when it changes under a booted app.
   */
  private async openByDeepLink(
    domain: string,
    options?: {
      start?: string;
      /** When set, only this chat actually opening counts as success. */
      expectedHashes?: string[];
      peerId?: string;
    }
  ): Promise<{ ok: boolean; error?: string }> {
    const resolve =
      options?.start == null
        ? `tg://resolve?domain=${domain}`
        : `tg://resolve?domain=${domain}&start=${options.start}`;
    const result = await this.run<{ ok: boolean; error?: string }>(
      DEEP_LINK_SCRIPT,
      {
        url: `https://web.telegram.org/k/#?tgaddr=${encodeURIComponent(resolve)}`,
        expectedHashes: options?.expectedHashes ?? [],
        peerId: options?.peerId ?? null,
      }
    );
    return { ok: result?.ok === true, error: result?.error };
  }

  /**
   * One BotFather exchange: send a line, return the reply text. The chat is
   * opened by deep link, not search or the list: web-k's search ignores
   * synthetic input, a fresh account has no BotFather row, and the deep link
   * resolves through Telegram itself, the one username no look-alike can hold.
   */
  private async talkBotFather(text: string): Promise<string | null> {
    if (!this.botFatherOpen) {
      const opened = await this.openByDeepLink("botfather", {
        expectedHashes: ["#@botfather"],
      });
      if (!opened.ok) {
        this.callbacks.onLog(
          `telegram-bot: could not open BotFather: ${opened.error ?? "no result"}`
        );
        return null;
      }
      this.botFatherOpen = true;
    }
    const result = await this.run<{
      ok: boolean;
      error?: string;
      reply?: string | null;
    }>(TALK_SCRIPT, { useOpenChat: true, text, waitReplyMs: 15_000 });
    if (result?.ok !== true) {
      this.botFatherOpen = false;
      this.callbacks.onLog(
        `telegram-bot: BotFather chat failed: ${result?.error ?? "no result"}`
      );
      return null;
    }
    // The whole exchange goes to the log; redact tokens here as the dump does.
    const redacted = (result.reply ?? "(no reply)")
      .replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, "<token>")
      .slice(0, 160);
    this.callbacks.onLog(`telegram-bot: BotFather ← "${text}" → "${redacted}"`);
    return result.reply ?? null;
  }

  /**
   * The nonce whose `/start` completes linking; regenerated on expiry so the
   * fallback link in the log and connect dialog stays live while we wait.
   */
  private ensureLinkNonce(): string {
    const now = Date.now();
    if (this.linkNonce == null || this.linkNonce.expiresAt <= now)
      this.linkNonce = {
        value: `link-${randomBytes(6).toString("hex")}`,
        expiresAt: now + LINK_NONCE_TTL_MS,
      };
    return this.linkNonce.value;
  }

  /**
   * Learn which bot chat is the account owner's. The proof travels through
   * Telegram's servers, not the page scraper: the bot chat opens with a
   * `?start=<nonce>` deep link, so the START press reaches the Bot API with
   * the nonce and handleBotInbound accepts that chat as "me". Retrying forever
   * is safe because an attempt has zero user-visible effects unless it
   * provably succeeds: nothing is pressed outside the bot's own chat (both
   * scripts verify it against the bot's id) and nothing is announced before
   * the nonce comes back.
   */
  private async linkSelf(): Promise<void> {
    const poller = this.botPoller;
    const username = this.botState.username;
    if (poller == null || username == null) return;
    this.linkAttempts += 1;

    const nonce = this.ensureLinkNonce();
    try {
      // A fresh renderer for every attempt: web-k caches a failed username
      // lookup for the life of the page (a seconds-old bot's first lookup
      // usually fails), and a page parked on BotFather is doomed anyway.
      {
        this.callbacks.onLog(
          "telegram-bot: fresh renderer for the link attempt"
        );
        this.botFatherOpen = false;
        const win = this.recreateWindow();
        if (win != null && !win.isDestroyed()) {
          // The deep link rides in the URL the page boots with: web-k only
          // honours a changed `#?tgaddr=` once its router is fully up, and a
          // post-reload hash change can sit in the hash unread.
          await win
            .loadURL(
              `${TELEGRAM_WEB_URL}#?tgaddr=${encodeURIComponent(
                `tg://resolve?domain=${username}&start=${nonce}`
              )}`
            )
            .catch(() => {});
        }
      }

      let opened = await this.openByDeepLink(username, {
        start: nonce,
        expectedHashes: [`#@${username}`, `#${poller.botId}`],
        peerId: poller.botId,
      });
      if (!opened.ok && this.linkAttempts >= 3) {
        // Two failed resolver rounds are enough evidence that the resolver
        // is the problem — from here, reach the chat through search instead.
        this.callbacks.onLog(
          `telegram-bot: the deep link keeps failing (${opened.error ?? "no detail"}) — trying the search box instead`
        );
        opened = await this.openBySearch(username);
      }
      if (!opened.ok) {
        this.callbacks.onLog(
          `telegram-bot: could not open @${username} to link: ${opened.error ?? "deep link failed"}`
        );
        return;
      }
      this.botFatherOpen = false;
      const started = await this.run<{ ok: boolean; error?: string }>(
        START_BOT_SCRIPT,
        {
          // Every spelling web-k uses for "the bot's chat is open": the hash
          // by username or peer id, or the active row carrying the bot's id.
          expectedHashes: [`#@${username}`, `#${poller.botId}`],
          peerId: poller.botId,
          nonce,
        }
      );
      if (started?.ok !== true) {
        this.callbacks.onLog(
          `telegram-bot: could not start @${username} to link: ${started?.error ?? "no result"}`
        );
        return;
      }

      // The /start travels to Telegram and back through the long poll;
      // handleBotInbound sets selfChatId when it lands; the page is not read.
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline && this.running) {
        if (this.botState.selfChatId != null) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      if (this.botState.selfChatId == null) {
        // Quick first retries (resolver propagation clears within a minute),
        // then a steady pace forever. The t.me link is for whoever debugs this.
        this.nextLinkAttempt =
          Date.now() +
          (this.linkAttempts <= LINK_RETRY_FAST_ATTEMPTS
            ? LINK_RETRY_FAST_MS
            : LINK_RETRY_STEADY_MS);
        this.callbacks.onLog(
          `telegram-bot: linking attempt ${this.linkAttempts} did not complete; retrying ` +
            `(manual fallback: https://t.me/${username}?start=${nonce})`
        );
      }
    }
  }

  /** A /start carrying the live nonce is the account owner — see linkSelf. */
  private completeLink(chatId: string): void {
    if (this.botState.selfChatId != null) return;
    this.botState = saveTelegramBotState({ selfChatId: chatId });
    this.linkNonce = null;
    this.linkAttempts = 0;
    this.callbacks.onLog(`telegram-bot: linked — "me" is chat ${chatId}`);
    this.callbacks.onSelfLinked?.();
    // Exactly one message, and only after the link is proven; announcing on
    // every attempt would write into the user's real Telegram all day.
    void this.botPoller
      ?.sendMessage(
        chatId,
        "AbacusAI Bot is linked to this AbacusAIBot install."
      )
      .catch(() => {});
  }

  private handleBotInbound(message: BotInbound): void {
    // A /start with a payload is handshake mechanics, never gateway traffic:
    // ours completes the link, a stale or foreign nonce is dropped.
    if (message.startPayload != null) {
      if (
        this.linkNonce != null &&
        Date.now() < this.linkNonce.expiresAt &&
        message.startPayload === this.linkNonce.value
      )
        this.completeLink(message.chatId);
      return;
    }
    this.botChats.add(message.chatId);
    if (message.media != null && message.media.length > 0) {
      // Media is still on Telegram's servers; fetch it before the gateway
      // sees the message, so the path in the frame is a file that exists.
      void this.deliverWithMedia(message);
      return;
    }
    this.callbacks.onMessage(message);
  }

  private async deliverWithMedia(message: BotInbound): Promise<void> {
    const attachments: NonNullable<InboundMessage["attachments"]> = [];
    for (const item of message.media ?? []) {
      try {
        const data = await this.botPoller!.downloadFile(item.fileId);
        attachments.push({
          path: saveInboundMedia("telegram", message.chatId, item.name, data),
          name: item.name,
          mimeType: item.mimeType,
        });
      } catch (error) {
        this.callbacks.onLog(
          `telegram-bot: media download failed: ${String((error as Error)?.message ?? error)}`
        );
      }
    }
    this.callbacks.onMessage({
      userId: message.userId,
      userName: message.userName,
      chatId: message.chatId,
      text: message.text,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  }

  /**
   * Files travel the bot lane only: the Bot API uploads natively, the web
   * session would need its page's attach flow. Auto-reply lives in those chats.
   */
  async sendFile(
    chatId: string,
    filePath: string,
    caption?: string
  ): Promise<void> {
    const target = chatId.trim();
    if (
      this.botPoller == null ||
      (target !== this.botState.selfChatId && !this.botChats.has(target))
    ) {
      throw new Error(
        "Sending files on Telegram works in the assistant-bot chats (yourself, and people who message the bot). For other chats, send a text instead."
      );
    }
    await this.botPoller.sendFile(target, filePath, caption);
  }

  // ── Inbound + contacts ─────────────────────────────────────────────────

  private startInboundPolling(): void {
    if (this.inboundTimer != null) clearInterval(this.inboundTimer);
    this.firstInboundSweep = true;
    this.inboundTimer = setInterval(
      () => void this.sweepInbound(),
      INBOUND_POLL_MS
    );
  }

  private async sweepInbound(): Promise<void> {
    if (!this.running || !this.loggedIn) return;
    // A bot that came up without learning "me", or never provisioned, retries
    // here, paced by the cooldowns (not every sweep, which would spam /start).
    if (
      this.botPoller == null &&
      !this.botStarting &&
      this.provisionFailures > 0 &&
      this.provisionFailures < 3 &&
      Date.now() >= this.nextProvisionAttempt
    )
      void this.ensureBotIdentity();
    if (
      this.botPoller != null &&
      this.botState.selfChatId == null &&
      !this.botStarting &&
      Date.now() >= this.nextLinkAttempt
    ) {
      this.botStarting = true;
      void this.linkSelf().finally(() => {
        this.botStarting = false;
      });
    }
    // Re-read the dialog list every tick so a chat added after login shows up.
    await this.refreshContacts();
    const rows = await this.run<
      Array<{ chatId: string; name: string; text: string; messageId: string }>
    >(INBOUND_SCRIPT, {});
    if (rows == null) return;

    for (const row of rows) {
      // Normalize scraped text before anything compares, stores or shows it.
      row.text = normalizeScrapedText(row.text);
      const previous = this.lastSeen.get(row.chatId);
      this.lastSeen.set(row.chatId, row.messageId);
      // The first sweep only seeds lastSeen; without this every existing
      // unread would replay into the agent the moment the platform connects.
      if (this.firstInboundSweep) continue;
      if (previous === row.messageId) continue;
      // Presence previews and our own outgoing replies are not inbound.
      if (isEphemeralPreview(row.text)) continue;
      if (previewMatchesSent(this.lastSentTexts.get(row.chatId), row.text))
        continue;
      // The bot's own chat never reports through this sweep: the poller is the
      // authority there and sees only what the user typed, while this scrape
      // sees both sides, so another bot's message would route as inbound. The
      // row's chat id is the bot's peer id, the numeric half of its token.
      const botPeerId = resolveBotToken(this.botState)?.split(":")[0] ?? null;
      if (
        (botPeerId != null && row.chatId === botPeerId) ||
        (this.botState.selfChatId != null &&
          row.chatId === this.botState.selfChatId)
      )
        continue;
      this.callbacks.onMessage({
        userId: row.chatId,
        userName: row.name,
        chatId: row.chatId,
        text: row.text,
      });
    }
    this.firstInboundSweep = false;
  }

  private async refreshContacts(): Promise<void> {
    const rows = await this.run<Array<{ chatId: string; name: string }>>(
      CONTACTS_SCRIPT,
      {}
    );
    if (rows != null) this.contacts = rows;
  }

  // ── Page driving ────────────────────────────────────────────────────────

  /**
   * The per-connector equivalent of an app restart: a new renderer process.
   * web-k's network engine runs in a worker that survives loadURL reloads
   * but dies with the process, taking its cached failed lookups with it. The
   * login lives in the on-disk partition and survives.
   */
  private recreateWindow(): BrowserWindow | null {
    const old = this.window;
    this.window = null;
    if (old != null && !old.isDestroyed()) old.destroy();
    return this.ensureWindow();
  }

  private ensureWindow(): BrowserWindow | null {
    if (this.window != null && !this.window.isDestroyed()) return this.window;
    if (!this.running) return null;
    // Rebuilt hidden either way; whoever needs the user's eyes on it shows it.
    const win = new BrowserWindow({
      show: false,
      width: 960,
      height: 720,
      title: "Log in to Telegram",
      // A child of the app window so it shares the app's Space (see start()).
      ...(parentWindow() != null ? { parent: parentWindow() } : {}),
      // Never modal, frameless, like the window built in start() — see there.
      autoHideMenuBar: true,
      frame: false,
      // See start(): painting and unthrottled so the driver works while hidden.
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition: TELEGRAM_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    // Muted: a hidden page still plays the web app's new-message sound.
    win.webContents.setAudioMuted(true);
    // Gone entirely, not just auto-hidden: Alt would bring it back. Windows
    // and Linux only — macOS has no per-window menu, and no removeMenu.
    if (process.platform !== "darwin") win.removeMenu();
    // Esc backs out of the login window — see start().
    dismissOnEscape(win);
    win.on("closed", () => {
      this.window = null;
    });
    void win.loadURL(TELEGRAM_WEB_URL);
    this.window = win;
    return win;
  }

  /**
   * Run one driver script against the page and return its JSON value. The
   * scripts are IIFE bodies reading an `args` object interpolated as a
   * literal, so the isolated world needs no channel back. Any throw resolves
   * to null ("not ready this tick"). The wrapper must be async: most scripts
   * use top-level `await`, a syntax error in a plain wrapper swallowed here.
   */
  private async run<T>(
    script: string,
    args: Record<string, unknown>
  ): Promise<T | null> {
    const win = this.ensureWindow();
    if (win == null || win.isDestroyed()) return null;
    try {
      const value = (await win.webContents.executeJavaScript(
        `(async function(args){ ${script} })(${JSON.stringify(args)})`,
        true
      )) as T;
      return value ?? null;
    } catch (error) {
      this.callbacks.onLog(
        `telegram-web: script failed: ${String((error as Error)?.message ?? error)}`
      );
      return null;
    }
  }
}

// ── Driver scripts (run in web.telegram.org's page) ────────────────────────
// Kept as strings, written against telegram-web-k's stable structure. Each
// returns a JSON-serialisable value.

/**
 * The signed-in account's own user id from web-k's `user_auth` record. Null
 * when unreadable; callers treat that as "cannot verify", never a mismatch.
 */
const ACCOUNT_ID_SCRIPT = `
  try {
    const raw = localStorage.getItem('user_auth');
    if (!raw) return { id: null };
    const parsed = JSON.parse(raw);
    const id = parsed && parsed.id != null ? String(parsed.id) : null;
    return { id: id && id.length > 0 ? id : null };
  } catch {
    return { id: null };
  }
`;

/** Logged in ⇢ the auth pages are gone. The sturdiest signal Telegram gives. */
const LOGIN_STATE_SCRIPT = `
  const loginVisible = document.body.classList.contains('has-auth-pages');
  // Signed in means the chat UI is actually there — never merely "not the
  // login page". A blank or half-booted page has no auth class either, and
  // it once wore a Connected badge while nothing could send or read.
  const chatUi = document.querySelector(
    '#chatlist-container, .chatlist-chat, #column-left .chatlist'
  ) != null;
  // When the login page is refusing — Telegram rate-limits QR attempts with
  // "too many attempts, please try later" — that sentence is the one thing
  // the user needs to hear. A tester was told to keep scanning a QR that
  // Telegram itself had locked.
  let loginError = null;
  if (loginVisible) {
    const text = (document.body.innerText || '');
    const m = /[^\\n]*(too many|try (again )?later|flood)[^\\n]*/i.exec(text);
    if (m) loginError = m[0].replace(/\\s+/g, ' ').trim().slice(0, 120);
  }
  return { loggedIn: !loginVisible && chatUi, loginVisible, loginError };
`;

/** The dialog list as contacts: chat id (peer id) and title. */
const CONTACTS_SCRIPT = `
  const rows = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('#chatlist-container a.chatlist-chat, ul.chatlist a.chatlist-chat, a.chatlist-chat')) {
    const id = el.getAttribute('data-peer-id');
    if (id == null || seen.has(id)) continue;
    const titleEl = el.querySelector('.user-title, .peer-title, .dialog-title');
    const name = (titleEl ? titleEl.textContent : el.textContent || '').trim();
    if (name.length === 0) continue;
    seen.add(id);
    rows.push({ chatId: id, name });
    if (rows.length >= 200) break;
  }
  return rows;
`;

/**
 * Read a chat's recent bubbles: open `args.target` (a peer id) with the same
 * pointer sequence a send uses, wait for bubbles, return direction, text and
 * timestamp for the last `args.limit`. [] if the chat cannot be opened.
 */
const READ_CHAT_SCRIPT = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const press = (el) => {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + Math.min(30, r.width / 2), clientY: r.y + Math.min(20, r.height / 2) };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  };
  const target = String(args.target || '').trim();
  const limit = Number(args.limit) || 30;
  const row = document.querySelector('a.chatlist-chat[data-peer-id="' + target + '"]');
  if (!row) return [];
  press(row);
  const t0 = Date.now();
  let bubbles = [];
  while (Date.now() - t0 < 6000) {
    bubbles = [...document.querySelectorAll('.bubbles .bubble, .bubble')];
    if (bubbles.length) break;
    await sleep(150);
  }
  const clean = (b) => {
    const m = b.querySelector('.message');
    if (!m) return '';
    const c = m.cloneNode(true);
    c.querySelectorAll('.time, .reactions, .bubble-name-wrapper').forEach((e) => e.remove());
    return c.textContent.replace(/\\s+/g, ' ').trim();
  };
  return bubbles
    .filter((b) => b.querySelector('.message'))
    .slice(-limit)
    .map((b) => ({
      direction: b.classList.contains('is-out') ? 'out' : 'in',
      text: clean(b),
      at: new Date((Number(b.getAttribute('data-timestamp')) || 0) * 1000).toISOString(),
    }))
    .filter((r) => r.text.length > 0);
`;

/** Unread dialog previews, as best-effort inbound signal. */
const INBOUND_SCRIPT = `
  const rows = [];
  for (const el of document.querySelectorAll('a.chatlist-chat')) {
    const badge = el.querySelector('.dialog-subtitle-badge-unread, .badge-unread, .unread');
    if (badge == null) continue;
    const id = el.getAttribute('data-peer-id');
    if (id == null) continue;
    const titleEl = el.querySelector('.user-title, .peer-title, .dialog-title');
    const previewEl = el.querySelector('.dialog-subtitle, .row-subtitle, .peer-subtitle');
    const name = (titleEl ? titleEl.textContent : '').trim();
    const text = (previewEl ? previewEl.textContent : '').trim();
    if (text.length === 0) continue;
    rows.push({ chatId: id, name, text, messageId: id + ':' + text });
  }
  return rows;
`;

/**
 * One exchange: open the chat, send `args.text`, and when `args.waitReplyMs`
 * > 0 wait for a new incoming bubble and return its text. With
 * `args.requirePeerId` only the row with that exact peer id is pressed:
 * search ranks look-alikes, and this conversation hands back a bot token.
 */
const TALK_SCRIPT = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const press = (el) => {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + Math.min(30, r.width / 2), clientY: r.y + Math.min(20, r.height / 2) };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  };
  const waitFor = async (sel, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const el = document.querySelector(sel);
      if (el) return el;
      await sleep(100);
    }
    return null;
  };

  const target = String(args.target || '').trim();
  const requirePeer = String(args.requirePeerId || '');
  const useOpenChat = args.useOpenChat === true;
  const text = String(args.text || '');
  const waitReplyMs = Number(args.waitReplyMs) || 0;
  if (text.length === 0) return { ok: false, error: 'Nothing to send.' };

  if (!useOpenChat) {
    // The chat must already have a row in the list — telegram-web-k's search
    // ignores synthetic input, so there is no typing a name here. Chats
    // without a row are opened by tgaddr deep link before this script runs.
    let row = null;
    if (requirePeer.length > 0) {
      row = document.querySelector('a.chatlist-chat[data-peer-id="' + requirePeer + '"]');
    } else {
      // Match on the row's TITLE, never the whole row text: a chat whose
      // message preview merely mentions the name — BotFather's own
      // "Done! ... t.me/<username>" — must not swallow the open.
      const wanted = target.replace(/^@/, '').toLowerCase();
      for (const el of document.querySelectorAll('a.chatlist-chat')) {
        const titleEl = el.querySelector('.user-title, .peer-title, .dialog-title');
        const title = (titleEl ? titleEl.textContent : '').trim().toLowerCase();
        if (title === wanted || title.replace(/\\s+/g, '') === wanted) { row = el; break; }
      }
    }
    if (!row) return { ok: false, error: 'No chat row for "' + target + '".' };
    press(row);
  }

  // Generous when the page just booted from a deep-link load.
  const composer = await waitFor('.input-message-input[contenteditable="true"], .input-message-input', useOpenChat ? 25000 : 8000);
  if (!composer) return { ok: false, error: 'The message box did not open.' };

  // Let the freshly opened chat settle before anything is counted or typed:
  // history bubbles mount asynchronously, and a composer that has just
  // appeared can still swallow insertText. Stable bubble count for 600ms is
  // "settled".
  let prevCount = -1;
  let stableSince = Date.now();
  const settleEnd = Date.now() + 4000;
  while (Date.now() < settleEnd) {
    const count = document.querySelectorAll('.bubbles .bubble').length;
    if (count !== prevCount) { prevCount = count; stableSince = Date.now(); }
    else if (Date.now() - stableSince > 600) break;
    await sleep(150);
  }

  // Real messages carry data-mid; date and service bubbles do not. Everything
  // newer than this watermark happened after our send — history backfill
  // (smaller mids) can never fake a reply.
  const maxMid = Math.max(0, ...[...document.querySelectorAll('.bubbles .bubble[data-mid]')]
    .map((b) => Number(b.getAttribute('data-mid')) || 0));

  // Type with verification: insertText into a not-quite-ready composer fails
  // SILENTLY, and an empty composer then passes the "did it send" check
  // vacuously — the exact failure that once swallowed /newbot whole.
  let typed = false;
  for (let attempt = 0; attempt < 3 && !typed; attempt++) {
    press(composer);
    composer.focus();
    document.execCommand('insertText', false, text);
    await sleep(250);
    typed = composer.textContent.includes(text.slice(0, 24));
  }
  if (!typed) return { ok: false, error: 'Could not type into the composer.' };

  const sendBtn = document.querySelector('.btn-send:not(.record)');
  if (sendBtn) press(sendBtn);
  else composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  await sleep(400);
  if (composer.textContent.trim().length > 0)
    return { ok: false, error: 'The message was typed but did not send.' };

  // The message must actually materialise as a new outgoing bubble.
  const sentEnd = Date.now() + 5000;
  let appeared = false;
  while (Date.now() < sentEnd && !appeared) {
    appeared = [...document.querySelectorAll('.bubbles .bubble.is-out[data-mid]')]
      .some((b) => (Number(b.getAttribute('data-mid')) || 0) > maxMid);
    if (!appeared) await sleep(200);
  }
  if (!appeared) return { ok: false, error: 'The message did not appear in the chat.' };
  if (waitReplyMs <= 0) return { ok: true, reply: null };

  // A reply can be a BURST — a greeting plus the actual prompt — and
  // returning on the first new message read the greeting and threw the
  // prompt away. Collect every new incoming until the burst settles, and
  // answer with all of them joined: token parsing, refusal detection and
  // the intro check all work on substrings.
  const newIncoming = () =>
    [...document.querySelectorAll('.bubbles .bubble:not(.is-out)[data-mid]')]
      .filter((b) => (Number(b.getAttribute('data-mid')) || 0) > maxMid)
      .sort((a, b2) => (Number(a.getAttribute('data-mid')) || 0) - (Number(b2.getAttribute('data-mid')) || 0));
  const replyEnd = Date.now() + waitReplyMs;
  let lastCount = 0;
  let settledSince = 0;
  while (Date.now() < replyEnd) {
    const found = newIncoming();
    if (found.length > 0) {
      if (found.length !== lastCount) {
        lastCount = found.length;
        settledSince = Date.now();
      } else if (Date.now() - settledSince > 1200) {
        const parts = [];
        for (const b of found) {
          const m = b.querySelector('.message');
          if (!m) continue;
          const clone = m.cloneNode(true);
          clone.querySelectorAll('.time, .reactions, .bubble-name-wrapper').forEach((e) => e.remove());
          parts.push(clone.textContent.replace(/\\s+/g, ' ').trim());
        }
        return { ok: true, reply: parts.join('\\n') };
      }
    }
    await sleep(200);
  }
  return { ok: true, reply: null };
`;

/**
 * Change the page hash to a `#?tgaddr=` deep link. The hash is cleared first:
 * an identical href fires no hashchange, and web-k only reacts when it changes.
 */
const DEEP_LINK_SCRIPT = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const url = String(args.url || '');
  if (url.length === 0) return { ok: false, error: 'No url.' };
  // A hash changed while the app is still booting is discarded, exactly like
  // a cold-load hash — and exactly when in the boot that happens is not
  // observable from here. So the link is VERIFIED and retried instead: on
  // success telegram-web-k rewrites the hash to #@username and mounts the
  // chat, and until it does the dance is repeated.
  const ready = Date.now() + 20000;
  while (Date.now() < ready) {
    if (!document.body.classList.contains('has-auth-pages') &&
        document.querySelector('a.chatlist-chat, ul.chatlist')) break;
    await sleep(300);
  }
  // "No tgaddr left in the hash and a composer exists" once counted as
  // success — but a resolve that silently fails leaves the PREVIOUS chat on
  // screen, which passes both. That is how a link to a just-created bot
  // (whose username Telegram's resolver has not propagated yet) reported ok
  // while the page still showed BotFather. When the caller says which chat
  // it expects, only that chat being open counts.
  const expected = (args.expectedHashes || []).map((h) => String(h).toLowerCase());
  const arrived = () => {
    if (expected.length === 0) return true;
    const h = (location.hash || '').toLowerCase();
    if (expected.some((e) => h === e || h.startsWith(e + '?'))) return true;
    return args.peerId != null && !!document.querySelector(
      'a.chatlist-chat.active[data-peer-id="' + args.peerId + '"]'
    );
  };
  // A page that BOOTED with this tgaddr already in its URL may be resolving
  // it right now — give that a moment and take the win, rather than clearing
  // the hash out from under an in-flight resolve.
  const settle = Date.now() + 12000;
  while (Date.now() < settle) {
    const chatReady = !!document.querySelector('.input-message-input');
    if (chatReady && arrived()) return { ok: true };
    if (!location.hash.includes('tgaddr')) break;
    await sleep(300);
  }
  // Two in-page rounds only: the connector's own retry loop owns
  // repetition, and a shorter attempt is what lets it actually fire on its
  // 30-second schedule instead of ~80 seconds of internal waiting.
  for (let attempt = 0; attempt < 2; attempt++) {
    await sleep(600);
    if (location.hash.length > 0) {
      location.hash = '';
      await sleep(200);
    }
    location.href = url;
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const resolved = !location.hash.includes('tgaddr');
      const chatUp = !!document.querySelector('.input-message-input');
      if (resolved && chatUp && arrived()) return { ok: true };
      await sleep(250);
    }
  }
  return {
    ok: false,
    error: 'The deep link never opened the chat (hash: ' + (location.hash || '').slice(0, 60) + ')',
  };
`;

/**
 * The search box's screen position, for a trusted click and typing; part of
 * the resolver-independent road to the bot's chat (see openBySearch).
 */
const SEARCH_BOX_SCRIPT = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const end = Date.now() + 15000;
  let box = null;
  while (Date.now() < end) {
    box = document.querySelector('.input-search input');
    if (box) break;
    await sleep(300);
  }
  if (!box) return { ok: false, error: 'no search box' };
  const r = box.getBoundingClientRect();
  return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
`;

/**
 * The search-result row carrying exactly the wanted @username; a row is only
 * returned when the unique username is in its text, and even a wrong click is
 * caught later because START refuses any chat that is not the bot's.
 */
const SEARCH_RESULT_SCRIPT = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bare = String(args.username).toLowerCase();
  const wanted = '@' + bare;
  const end = Date.now() + 12000;
  let sample = [];
  while (Date.now() < end) {
    sample = [];
    for (const row of document.querySelectorAll('a.chatlist-chat')) {
      const text = (row.textContent || '').toLowerCase();
      if (sample.length < 3) sample.push(text.slice(0, 40));
      // The @-prefixed subtitle is the exact form, but some result styles
      // render the username bare — the random suffix keeps a bare match
      // unambiguous.
      if (!text.includes(wanted) && !text.includes(bare)) continue;
      const r = row.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(20, r.height / 2)) };
    }
    await sleep(400);
  }
  return {
    ok: false,
    error: 'no search result carrying ' + wanted +
      (sample.length ? ' (rows seen: ' + sample.join(' | ') + ')' : ' (no rows at all)'),
  };
`;

/**
 * The newest AbacusAI bot token in BotFather's history. Every bot this app
 * created announced itself in a "Done!" message carrying its token, and an
 * old bot skips /newbot and the new-username indexing lag. Incoming bubbles
 * only; the token is validated with getMe before anything trusts it.
 */
const BOTFATHER_HISTORY_SCRIPT = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const end0 = Date.now() + 8000;
  while (Date.now() < end0) {
    if (document.querySelector('.bubbles .bubble')) break;
    await sleep(300);
  }
  // Token-shaped text appears ONLY in BotFather's own Done!/token messages,
  // so any token in an incoming bubble is a bot this account owns — getMe
  // then says which, and the caller checks it is ours before adopting.
  const scan = () => {
    const bubbles = [...document.querySelectorAll('.bubbles .bubble:not(.is-out)')];
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const text = (bubbles[i].textContent || '');
      const token = /\\b(\\d{6,}:[A-Za-z0-9_-]{30,})\\b/.exec(text);
      if (token) return token[1];
    }
    return null;
  };
  // The list is virtualised and the Done! messages sit hours above the
  // rendered tail. The scroller is found by walking up from the bubbles to
  // the first ancestor that actually scrolls, rather than guessing a class.
  // The scroll container is a DESCENDANT of the chat column, not an
  // ancestor — the previous ancestor walk found nothing and the scan gave
  // up at the visible tail ("scrolled 0 pages" in the field log). Take the
  // outermost element in the column that actually scrolls.
  let pane = null;
  for (const el of document.querySelectorAll('.bubbles, .bubbles *')) {
    if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 200) {
      pane = el;
      break;
    }
  }
  // Load-aware, not distance-based: jumping screens outran Telegram's lazy
  // history loading — fifteen "pages" of scrolling once accumulated only 52
  // bubbles. Jump to the top of what IS loaded, wait for older history to
  // mount (the bubble count grows), and stop only when it stops growing.
  let pages = 0;
  let lastCount = 0;
  let stalls = 0;
  for (; pages < 40 && stalls < 3; pages++) {
    const token = scan();
    if (token)
      return { token, pages, bubbles: document.querySelectorAll('.bubbles .bubble').length };
    if (!pane) break;
    pane.scrollTop = 0;
    await sleep(900);
    const count = document.querySelectorAll('.bubbles .bubble').length;
    if (count <= lastCount) stalls += 1;
    else stalls = 0;
    lastCount = count;
  }
  return { token: null, pages, bubbles: document.querySelectorAll('.bubbles .bubble').length };
`;

/**
 * Start the bot whose chat the deep link just opened: press START, or for a
 * bot already started once send `/start <nonce>`. It refuses any chat that
 * is not verifiably the bot's: an unresolved deep link leaves BotFather on
 * screen with a composer, and a START pressed there is the user's own.
 */
const START_BOT_SCRIPT = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const press = (el) => {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + Math.min(30, r.width / 2), clientY: r.y + Math.min(20, r.height / 2) };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  };
  const findStart = () =>
    [...document.querySelectorAll('button')].find((b) => /^start$/i.test((b.textContent || '').trim()));
  const expected = args.expectedHashes.map((h) => h.toLowerCase());
  const onBotChat = () => {
    const h = (location.hash || '').toLowerCase();
    if (expected.some((e) => h === e || h.startsWith(e + '?'))) return true;
    // The hash formats have shifted across web-k builds; the active
    // chat-list row's peer id is the other spelling of the same fact.
    return !!document.querySelector(
      'a.chatlist-chat.active[data-peer-id="' + args.peerId + '"]'
    );
  };
  const end = Date.now() + 25000;
  let composer = null;
  while (Date.now() < end) {
    if (onBotChat()) {
      composer = document.querySelector('.input-message-input');
      if (composer || findStart()) break;
    }
    await sleep(300);
  }
  if (!onBotChat())
    return { ok: false, error: 'a different chat is open (hash: ' + (location.hash || '').slice(0, 60) + ')' };
  const startBtn = findStart();
  if (startBtn) {
    press(startBtn);
    await sleep(500);
    return { ok: true };
  }
  if (!composer) return { ok: false, error: 'The bot chat did not open.' };
  composer.focus();
  document.execCommand('insertText', false, '/start ' + args.nonce);
  await sleep(250);
  const sendBtn = document.querySelector('.btn-send:not(.record)');
  if (sendBtn) press(sendBtn);
  else composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  await sleep(400);
  return { ok: true };
`;
