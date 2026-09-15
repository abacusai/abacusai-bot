import fs from "fs";
import path from "path";

import { BrowserWindow } from "electron";

import type { MessagingPlatformId } from "#shared/messaging";

import {
  bringToFront,
  dismissOnEscape,
  parentWindow,
  presentAsDialog,
} from "../../bring-to-front";
import { abacusBotHome } from "../../paths";
import {
  chunkMessage,
  isEphemeralPreview,
  previewMatchesSent,
  normalizeScrapedText,
  type ConnectorCallbacks,
  type MessagingConnector,
} from "./connector";

/**
 * Telegram, by driving the real web.telegram.org in a hidden BrowserWindow:
 * the user signs in to Telegram's own web app and the agent drives the
 * logged-in page to send and read; the session persists in its own partition.
 * Messages to the user themself travel the shared Abacus AI bot's lane
 * (abacus_telegram), not this one. The driver scripts' DOM selectors are the
 * brittle part.
 */

const TELEGRAM_WEB_URL = "https://web.telegram.org/k/";

/** Holds the login; survives restarts, cleared on disconnect. */
const TELEGRAM_PARTITION = "persist:telegram-web";

/**
 * Earlier releases minted a Bot API bot through BotFather and kept its token
 * here. The shared Abacus AI bot replaced it; a token nothing reads is a
 * secret with no reason to stay on disk.
 */
const LEGACY_BOT_STATE_FILE = "telegram-bot.json";

const forgetLegacyBotState = (log: (line: string) => void): void => {
  const file = path.join(abacusBotHome(), LEGACY_BOT_STATE_FILE);
  try {
    if (!fs.existsSync(file)) return;
    fs.rmSync(file, { force: true });
    log(
      `telegram-web: removed the retired assistant bot's ${LEGACY_BOT_STATE_FILE}`
    );
  } catch (error) {
    log(
      `telegram-web: could not remove ${LEGACY_BOT_STATE_FILE}: ${String((error as Error)?.message ?? error)}`
    );
  }
};

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

  constructor(private readonly callbacks: ConnectorCallbacks) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.callbacks.onState("connecting");
    forgetLegacyBotState(this.callbacks.onLog);

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

    const target = chatId.trim();
    // Verified end to end: typing confirmed in the composer, the message
    // confirmed as a new outgoing bubble.
    for (const chunk of chunkMessage(text, MAX_MESSAGE_LENGTH)) {
      const attempt = async (): Promise<{
        ok: boolean;
        error?: string;
      } | null> =>
        this.run<{ ok: boolean; error?: string }>(TALK_SCRIPT, {
          target,
          requirePeerId: /^-?\d+$/.test(target) ? target : "",
          text: chunk,
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
 * Open a chat from the list and send `args.text`. With `args.requirePeerId`
 * only the row with that exact peer id is pressed: titles can collide.
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
  const text = String(args.text || '');
  if (text.length === 0) return { ok: false, error: 'Nothing to send.' };

  // The chat must already have a row in the list — telegram-web-k's search
  // ignores synthetic input, so there is no typing a name here.
  let row = null;
  if (requirePeer.length > 0) {
    row = document.querySelector('a.chatlist-chat[data-peer-id="' + requirePeer + '"]');
  } else {
    // Match on the row's TITLE, never the whole row text: a chat whose
    // message preview merely mentions the name must not swallow the open.
    const wanted = target.replace(/^@/, '').toLowerCase();
    for (const el of document.querySelectorAll('a.chatlist-chat')) {
      const titleEl = el.querySelector('.user-title, .peer-title, .dialog-title');
      const title = (titleEl ? titleEl.textContent : '').trim().toLowerCase();
      if (title === wanted || title.replace(/\\s+/g, '') === wanted) { row = el; break; }
    }
  }
  if (!row) return { ok: false, error: 'No chat row for "' + target + '".' };
  press(row);

  const composer = await waitFor('.input-message-input[contenteditable="true"], .input-message-input', 8000);
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
  // vacuously.
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
  return { ok: true };
`;
