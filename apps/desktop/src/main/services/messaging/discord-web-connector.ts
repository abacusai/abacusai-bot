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
  setFileInput,
} from "./connector";

/**
 * Discord, by driving the real discord.com web app in a hidden BrowserWindow
 * of its own (it must outlive renderer navigations): no bot token, the user
 * logs into Discord's page and the agent drives that session. Chat ids: a DM
 * is its bare channel id, a server channel is `guildId/channelId`, a bare
 * guild id opens the server's default channel. Selectors use Discord's stable
 * hooks (channel links, `guildsnav___<id>`, ARIA roles), not hashed classes.
 */

/** The user's DM home. Redirects to /login when there is no session. */
const DISCORD_WEB_URL = "https://discord.com/channels/@me";

const DISCORD_ORIGIN = "https://discord.com";

/** Holds the login across restarts; shared with the bot's install window. */
export const DISCORD_PARTITION = "persist:discord-web";

// discord.com can wedge its boot spinner under the default Electron UA.
const userAgent = (): string =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

/** Discord's message cap, kept a little under. */
const MAX_MESSAGE_LENGTH = 1900;

/** How often to check whether the user has finished logging in. */
const LOGIN_POLL_MS = 1500;

/** How often to sweep the DM list for new inbound messages. */
const INBOUND_POLL_MS = 5000;

/** Login polls stuck on the boot spinner before the page is reloaded. */
const STUCK_BOOT_POLLS = 20;

/** How many servers the post-connect crawl visits, and channels kept each. */
const MAX_GUILDS = 50;
const MAX_CHANNELS_PER_GUILD = 50;

/** How long to wait for a chat to render after opening it. */
const OPEN_CHAT_TIMEOUT_MS = 15_000;
/** Page tasks a read may find ahead of it before it declines to wait. */
const MAX_QUEUED_READS = 2;
/**
 * Read/search deadline, queue wait included: a bounded "could not" beats an
 * answer after the model gave up, and the caller has the stored copy.
 */
const READ_DEADLINE_MS = 45_000;

/** Unscoped searches walk servers one by one; capped to stay a tool call. */
const MAX_SEARCH_GUILDS = 5;

type LoginState = { loggedIn: boolean; loginVisible?: boolean };

type GuildRow = { guildId: string; name: string; mentions: number };

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isBareId = (value: string): boolean => /^\d+$/.test(value);

/**
 * The substring both send verifications look for. Never the raw head:
 * Discord renders emoji as <img>, which textContent drops.
 */
// FE0F and 200D are combining-class characters (no-misleading-character-class
// forbids them in a class); as alternatives they match alike.
const EMOJIISH =
  /[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{2700}-\u{27BF}]|\u{FE0F}|\u{200D}/gu;

export const sendProbe = (text: string): string => {
  let best = "";
  for (const line of text.split("\n")) {
    for (const segment of line.split(EMOJIISH)) {
      const plain = segment.trim();
      if (plain.length > best.length) best = plain;
    }
  }
  return best.length > 0 ? best.slice(0, 40).trim() : text.slice(0, 40);
};

/** `guildId/channelId`: the server-channel form of a chat id. */
const parseGuildChannel = (
  value: string
): { guildId: string; channelId: string } | null => {
  const m = /^(\d+)\/(\d+)$/.exec(value);
  return m == null ? null : { guildId: m[1], channelId: m[2] };
};

export class DiscordWebConnector implements MessagingConnector {
  readonly id: MessagingPlatformId = "discord";

  private window: BrowserWindow | null = null;
  private running = false;
  private loggedIn = false;
  /** Consecutive signed-out polls after a login. See checkLogin. */
  private signedOutTicks = 0;
  /** Consecutive polls stuck between login form and app. See checkLogin. */
  private bootStuckTicks = 0;
  private loginTimer: NodeJS.Timeout | null = null;
  private inboundTimer: NodeJS.Timeout | null = null;
  /** DMs, off the home page's private-channels rail. */
  private contacts: Array<{ chatId: string; name: string }> = [];
  /** Rail reads since login. The rail renders after `connected`: one empty
   * read is "not there yet", two is "no DMs". */
  private railReads = 0;
  private contactsRead = false;
  /** Joined servers, off the guild rail. Also carries the mention sweep. */
  private guilds: GuildRow[] = [];
  /** Guild id -> its channels, filled by the post-connect crawl. */
  private guildChannels = new Map<
    string,
    Array<{ chatId: string; name: string }>
  >();
  /** When the last channel crawl ran; the sweep retries a failed one. */
  private lastCrawlAt = 0;
  /** The rail-shape diagnostic runs once per connect, and only on failure. */
  private railShapeLogged = false;
  /** The last DM-contact count logged, so the log line fires on change only. */
  private loggedContactCount = -1;
  /** Chat id -> the last inbound message id we already reported, for dedupe. */
  private lastSeen = new Map<string, string>();
  /** Chat id -> recent texts we sent there, so the sweep skips our own echoes. */
  private lastSentTexts = new Map<string, string[]>();

  /** Keep the last few outbound texts per chat: every chunk of a multi-message
   * reply must be guarded against echoing back as inbound, not just the last. */
  private rememberSent(chatId: string, text: string): void {
    const ring = this.lastSentTexts.get(chatId) ?? [];
    ring.push(text);
    if (ring.length > 5) ring.shift();
    this.lastSentTexts.set(chatId, ring);
  }
  private firstInboundSweep = true;

  /** Everything that drives the shared page runs through this queue. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Serialized tasks currently holding the page; checkLogin stands aside. */
  private driving = 0;

  /** Tasks queued for the page, the running one included. */
  private pending = 0;
  /** See READ_DEADLINE_MS; a field so a test can shorten it. */
  private readDeadlineMs = READ_DEADLINE_MS;

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const wrapped = async (): Promise<T> => {
      this.driving += 1;
      try {
        return await task();
      } finally {
        this.driving -= 1;
        this.pending -= 1;
      }
    };
    const run = this.queue.then(wrapped, wrapped);
    // Failures belong to the caller, not to whoever is next in line.
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  constructor(private readonly callbacks: ConnectorCallbacks) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.callbacks.onState("connecting");

    // Hidden: the connect dialog reveals the window when a login form is up.
    this.window = this.buildWindow(false);
    try {
      await this.window.loadURL(DISCORD_WEB_URL, { userAgent: userAgent() });
    } catch (error) {
      this.callbacks.onLog(
        `discord-web: initial load failed: ${String((error as Error)?.message ?? error)}`
      );
    }

    if (!this.running) return;
    this.pollLogin();
    void this.checkLogin();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.loggedIn = false;
    this.railReads = 0;
    this.contactsRead = false;
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
      throw new Error("Discord is not logged in yet. Finish signing in first.");
    return this.serialize(() => this.sendTextNow(chatId, text));
  }

  private async sendTextNow(chatId: string, text: string): Promise<void> {
    const opened = await this.openChat(chatId);
    try {
      if (!opened.ready)
        throw new Error(`The Discord chat ${chatId} did not load.`);
      for (const chunk of chunkMessage(text, MAX_MESSAGE_LENGTH)) {
        await this.sendChunk(chatId, chunk);
        // The sweep compares previews against these to skip our own echoes.
        this.rememberSent(chatId, chunk);
      }
    } finally {
      // The DM rail the sweeps read exists only on the home page.
      if (opened.onGuildPage) await this.goHome();
    }
  }

  /**
   * Slate ignores synthetic input, so text goes in via `insertText` and Enter
   * via `sendInputEvent`; the script only reports the composer's position.
   */
  private async sendChunk(chatId: string, text: string): Promise<void> {
    const win = this.ensureWindow();
    if (win == null || win.isDestroyed())
      throw new Error("Discord is not running.");

    const box = await this.run<{ ok: boolean; x?: number; y?: number }>(
      FOCUS_COMPOSER_SCRIPT,
      {}
    );
    if (box?.ok !== true)
      throw new Error(
        `The message box for ${chatId} did not open. No permission to post there, or the channel did not load.`
      );

    // A trusted click places the Slate caret; a synthetic one does not.
    if (box.x != null && box.y != null) {
      win.webContents.sendInputEvent({
        type: "mouseDown",
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
      });
      win.webContents.sendInputEvent({
        type: "mouseUp",
        x: box.x,
        y: box.y,
        button: "left",
        clickCount: 1,
      });
      await delay(150);
    }

    // An empty composer after Enter also matches "text never entered".
    const probe = sendProbe(text);

    win.webContents.insertText(text);
    await delay(250);
    let typed = await this.run<{ has: boolean }>(COMPOSER_HAS_TEXT_SCRIPT, {
      probe,
    });
    if (typed?.has !== true) {
      // Focus went elsewhere; refocus and try once more.
      await this.run<{ ok: boolean }>(FOCUS_COMPOSER_SCRIPT, {});
      if (box.x != null && box.y != null) {
        win.webContents.sendInputEvent({
          type: "mouseDown",
          x: box.x,
          y: box.y,
          button: "left",
          clickCount: 1,
        });
        win.webContents.sendInputEvent({
          type: "mouseUp",
          x: box.x,
          y: box.y,
          button: "left",
          clickCount: 1,
        });
        await delay(200);
      }
      win.webContents.insertText(text);
      await delay(250);
      typed = await this.run<{ has: boolean }>(COMPOSER_HAS_TEXT_SCRIPT, {
        probe,
      });
      if (typed?.has !== true)
        throw new Error(
          `Could not type into the composer for ${chatId}. The page kept focus elsewhere.`
        );
    }

    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
    await delay(400);

    const cleared = await this.run<{ empty: boolean }>(
      COMPOSER_EMPTY_SCRIPT,
      {}
    );
    if (cleared?.empty !== true) {
      throw new Error(`The message to ${chatId} was typed but did not send.`);
    }

    // A cleared composer alone does not prove delivery.
    const shown = await this.waitForSentText(probe);
    if (!shown) {
      const shape = await this.run<Record<string, unknown>>(
        SEND_FAILURE_SHAPE_SCRIPT,
        {}
      );
      this.callbacks.onLog(
        `discord-web: send to ${chatId} vanished, page ${JSON.stringify(shape)}`
      );
      throw new Error(
        `The message to ${chatId} cleared the composer but never appeared in the channel.`
      );
    }
  }

  private async waitForSentText(probe: string): Promise<boolean> {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const seen = await this.run<{ has: boolean }>(LAST_MESSAGES_HAVE_SCRIPT, {
        probe,
      });
      if (seen?.has === true) return true;
      await delay(300);
    }
    return false;
  }

  /**
   * The composer form keeps a hidden `<input type="file">`; the file goes on
   * it through the debugger and a real Enter sends chip plus caption together.
   */
  async sendFile(
    chatId: string,
    filePath: string,
    caption?: string
  ): Promise<void> {
    if (!this.loggedIn)
      throw new Error("Discord is not logged in yet. Finish signing in first.");
    return this.serialize(() => this.sendFileNow(chatId, filePath, caption));
  }

  private async sendFileNow(
    chatId: string,
    filePath: string,
    caption?: string
  ): Promise<void> {
    const win = this.ensureWindow();
    if (win == null || win.isDestroyed())
      throw new Error("Discord is not running.");

    const opened = await this.openChat(chatId);
    try {
      if (!opened.ready)
        throw new Error(`The Discord chat ${chatId} did not load.`);
      const box = await this.run<{ ok: boolean; x?: number; y?: number }>(
        FOCUS_COMPOSER_SCRIPT,
        {}
      );
      if (box?.ok !== true)
        throw new Error(
          `The message box for ${chatId} did not open. No permission to post there, or the channel did not load.`
        );

      await setFileInput(
        win,
        'form input[type="file"], input[type="file"]',
        filePath
      );
      // The upload chip takes a moment to appear above the composer.
      await delay(1200);

      if (box.x != null && box.y != null) {
        win.webContents.sendInputEvent({
          type: "mouseDown",
          x: box.x,
          y: box.y,
          button: "left",
          clickCount: 1,
        });
        win.webContents.sendInputEvent({
          type: "mouseUp",
          x: box.x,
          y: box.y,
          button: "left",
          clickCount: 1,
        });
        await delay(150);
      }
      if (caption != null && caption.length > 0) {
        win.webContents.insertText(caption.slice(0, 1800));
        await delay(150);
      }
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
      win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
      await delay(1000);

      const still = await this.run<{ uploading: boolean }>(
        UPLOAD_PENDING_SCRIPT,
        {}
      );
      if (still?.uploading === true)
        throw new Error(
          `The file was staged but did not send to ${chatId}. The upload chip is still showing.`
        );
    } finally {
      if (opened.onGuildPage) await this.goHome();
    }
  }

  /** See MessagingConnector.contactsReady. */
  contactsReady(): boolean {
    return this.contactsRead;
  }

  /** DMs, then the servers (bare guild id), then every crawled channel. */
  listContacts(): Array<{ chatId: string; name: string }> {
    const rows = [...this.contacts];
    for (const guild of this.guilds)
      rows.push({ chatId: guild.guildId, name: `${guild.name} (server)` });
    for (const channels of this.guildChannels.values()) rows.push(...channels);
    return rows;
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
    const id = chatId.trim();
    if (!isBareId(id) && parseGuildChannel(id) == null) return [];
    return this.boundedRead("read", () =>
      this.serialize(() => this.readChatNow(id, limit))
    );
  }

  /** A read behind other reads fails at once; an admitted one cannot run past
   * the deadline. Sends are never cut short. */
  private boundedRead<T>(what: string, work: () => Promise<T>): Promise<T> {
    if (this.pending >= MAX_QUEUED_READS)
      return Promise.reject(
        new Error(
          `Discord is busy with another chat right now, so it could not ${what} live. The stored messages are what there is for the moment. Try again shortly.`
        )
      );
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.callbacks.onLog(
          `discord-web: ${what} did not finish within ${Math.round(this.readDeadlineMs / 1000)}s, answering from the stored copy`
        );
        reject(
          new Error(
            `Discord did not finish the live ${what} within ${Math.round(this.readDeadlineMs / 1000)}s. The stored messages are what there is for the moment.`
          )
        );
      }, this.readDeadlineMs);
      work().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      );
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
    const opened = await this.openChat(chatId);
    try {
      // Ready accepts the composer, which renders before the message list, so
      // poll for messages; a never-ready page (a forum grid) gets one pass.
      const end = opened.ready ? Date.now() + 8000 : Date.now();
      let rows: Array<{
        userName: string | null;
        text: string;
        direction: "in" | "out";
        at: string;
      }> | null = null;
      for (;;) {
        rows = await this.run(READ_CURRENT_SCRIPT, { limit });
        if (rows != null && rows.length > 0) break;
        // Forum channels render a post grid, never a message list.
        const posts = await this.run<
          Array<{ title: string; snippet: string; threadId: string }>
        >(FORUM_POSTS_SCRIPT, { limit });
        if (posts != null && posts.length > 0) {
          // A post is a thread; `guildId/threadId` reads like any channel.
          const guildId = chatId.split("/")[0];
          if (posts.every((post) => post.threadId.length === 0)) {
            const shape = await this.run<Record<string, unknown>>(
              FORUM_SHAPE_SCRIPT,
              {}
            );
            this.callbacks.onLog(
              `discord-web: forum posts carry no thread ids, card shape ${JSON.stringify(shape)}`
            );
          }
          return posts.map((post) => {
            const ref =
              post.threadId.length > 0
                ? `[forum post ${guildId}/${post.threadId}]`
                : "[forum post]";
            return {
              userName: null,
              text:
                post.snippet.length > 0
                  ? `${ref} ${post.title}: ${post.snippet}`
                  : `${ref} ${post.title}`,
              direction: "in" as const,
              at: new Date().toISOString(),
            };
          });
        }
        if (Date.now() >= end) break;
        await delay(500);
      }
      if (rows == null || rows.length === 0) {
        // Log the page shape so a missed selector does not read as "empty".
        const shape = await this.run<Record<string, unknown>>(
          PAGE_SHAPE_SCRIPT,
          {}
        );
        this.callbacks.onLog(
          `discord-web: nothing readable in ${chatId}, page shape ${JSON.stringify(shape)}`
        );
      }
      return rows ?? [];
    } finally {
      if (opened.onGuildPage) await this.goHome();
    }
  }

  /**
   * Discord has no global search: `scope` or an `in:<id>` prefix picks one
   * server or DM; otherwise joined servers are searched in rail order, capped.
   */
  async searchMessages(
    query: string,
    limit: number,
    scope?: string
  ): Promise<
    Array<{ chatId: string; name: string; snippet: string; when: string }>
  > {
    if (!this.loggedIn) return [];
    return this.boundedRead("search", () =>
      this.serialize(() => this.searchMessagesNow(query, limit, scope))
    );
  }

  private async searchMessagesNow(
    query: string,
    limit: number,
    scope?: string
  ): Promise<
    Array<{ chatId: string; name: string; snippet: string; when: string }>
  > {
    let text = query.trim();
    let scopes: string[];
    const prefixed = /^in:(\S+)\s+(.+)$/.exec(text);
    if (scope != null && scope.trim().length > 0) {
      scopes = [scope.trim()];
    } else if (prefixed != null) {
      scopes = [prefixed[1]];
      text = prefixed[2];
    } else {
      scopes = this.guilds
        .slice(0, MAX_SEARCH_GUILDS)
        .map((guild) => guild.guildId);
    }
    if (text.length === 0 || scopes.length === 0) return [];

    const out: Array<{
      chatId: string;
      name: string;
      snippet: string;
      when: string;
    }> = [];
    let navigated = false;
    try {
      for (const scopeId of scopes) {
        if (out.length >= limit) break;
        navigated = true;
        out.push(
          ...(await this.searchInScope(scopeId, text, limit - out.length))
        );
      }
    } finally {
      if (navigated) await this.goHome();
    }
    return out.slice(0, limit);
  }

  /** One scoped search. The bar is an editor, so the query is trusted input. */
  private async searchInScope(
    scopeId: string,
    text: string,
    limit: number
  ): Promise<
    Array<{ chatId: string; name: string; snippet: string; when: string }>
  > {
    const win = this.ensureWindow();
    if (win == null || win.isDestroyed()) return [];

    const opened = await this.openChat(scopeId);
    if (!opened.ready) return [];

    const bar = await this.run<{ ok: boolean; x?: number; y?: number }>(
      SEARCH_BAR_POS_SCRIPT,
      {}
    );
    if (bar?.ok !== true || bar.x == null || bar.y == null) {
      this.callbacks.onLog(
        `discord-web: no search bar in scope ${scopeId}, skipping`
      );
      return [];
    }
    win.webContents.sendInputEvent({
      type: "mouseDown",
      x: bar.x,
      y: bar.y,
      button: "left",
      clickCount: 1,
    });
    win.webContents.sendInputEvent({
      type: "mouseUp",
      x: bar.x,
      y: bar.y,
      button: "left",
      clickCount: 1,
    });
    await delay(300);
    win.webContents.insertText(text);
    await delay(400);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    win.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });

    // Results render async; poll until hits or the pane says zero.
    let result: {
      hits: Array<{ text: string; name: string; when: string }>;
    } | null = null;
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      result = await this.run(SEARCH_RESULTS_SCRIPT, {});
      if (result != null && result.hits.length > 0) break;
      await delay(500);
    }

    // Close the search pane so the next scope starts clean.
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await delay(200);

    const guildId = scopeId.split("/")[0];
    const guildName =
      this.guilds.find((guild) => guild.guildId === guildId)?.name ?? "";
    const channels = this.guildChannels.get(guildId) ?? [];
    return (result?.hits ?? []).slice(0, limit).map((hit) => {
      // Map the result group's channel name back to an openable chat id.
      const channel = channels.find(
        (row) => row.name.startsWith(`#${hit.name} `) || row.name === hit.name
      );
      return {
        chatId: channel?.chatId ?? scopeId,
        name:
          hit.name.length > 0
            ? `#${hit.name}${guildName.length > 0 ? ` (${guildName})` : ""}`
            : guildName || scopeId,
        snippet: normalizeScrapedText(hit.text),
        when: hit.when,
      };
    });
  }

  // ── Login ──────────────────────────────────────────────────────────────

  private pollLogin(): void {
    if (this.loginTimer != null) clearInterval(this.loginTimer);
    this.loginTimer = setInterval(() => void this.checkLogin(), LOGIN_POLL_MS);
  }

  /** See MessagingConnector.probeLive: one login check, now, then the answer. */
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
    // A page mid-navigation reads as neither logged in nor out.
    if (this.driving > 0) return;
    const state = await this.run<LoginState>(LOGIN_STATE_SCRIPT, {});
    if (state == null) return;

    if (state.loggedIn) this.signedOutTicks = 0;
    if (state.loggedIn || state.loginVisible === true) this.bootStuckTicks = 0;

    if (state.loggedIn && !this.loggedIn) {
      this.loggedIn = true;
      const win = this.window;
      if (win != null && !win.isDestroyed() && win.isVisible()) {
        win.hide();
        // Put the app in front rather than whatever the OS picks after a hide.
        bringToFront();
      }
      this.callbacks.onLog("discord-web: connected");
      this.callbacks.onState("connected");
      // The login poll keeps running after connect: it is the only thing
      // that notices a session revoked from the phone.
      this.startInboundPolling();
      this.railShapeLogged = false;
      void this.serialize(() => this.refreshContacts());
      // A reconnect keeps the crawled channel map.
      if (this.guildChannels.size === 0)
        void this.serialize(() => this.crawlGuilds());
      return;
    }

    // A login form is a wait on a human, not a failure: `needs_login` keeps
    // the gateway from restarting us. Only the connect dialog shows the window.
    if (!state.loggedIn && !this.loggedIn && state.loginVisible === true) {
      this.callbacks.onState(
        "needs_login",
        "Discord is not signed in. Sign in to connect."
      );
      return;
    }

    // Neither login form nor app: Discord's boot spinner, which can wedge
    // indefinitely; a reload with the session in the partition comes back in.
    if (!state.loggedIn && !this.loggedIn) {
      this.bootStuckTicks += 1;
      if (this.bootStuckTicks >= STUCK_BOOT_POLLS) {
        this.bootStuckTicks = 0;
        this.callbacks.onLog(
          "discord-web: stuck on the boot spinner, reloading the page"
        );
        const win = this.window;
        if (win != null && !win.isDestroyed())
          void win
            .loadURL(DISCORD_WEB_URL, { userAgent: userAgent() })
            .catch(() => undefined);
      }
      return;
    }

    if (!state.loggedIn && this.loggedIn) {
      // Two consecutive polls: a page mid-reload can briefly read as signed
      // out, and a false flap tells every conversation the platform vanished.
      this.signedOutTicks += 1;
      if (this.signedOutTicks < 2) return;
      this.signedOutTicks = 0;
      this.loggedIn = false;
      this.railReads = 0;
      this.contactsRead = false;
      this.callbacks.onState(
        "needs_login",
        "Discord is signed out because the session expired. Reconnect to sign in again."
      );
      this.pollLogin();
    }
  }

  /** Bring the login window back to the front (re-scan, or first login). */
  showLoginWindow(): void {
    const win = this.ensureWindow();
    if (win == null) return;
    presentAsDialog(win);
  }

  /** True once the user has signed in; surfaced to the connect dialog. */
  get isLoggedIn(): boolean {
    return this.loggedIn;
  }

  // ── Inbound + contacts ─────────────────────────────────────────────────

  private startInboundPolling(): void {
    if (this.inboundTimer != null) clearInterval(this.inboundTimer);
    this.firstInboundSweep = true;
    this.inboundTimer = setInterval(() => {
      // Sweeps queued behind a send/read/crawl would all run back to back.
      if (this.driving > 0) return;
      void this.serialize(() => this.sweepInbound());
    }, INBOUND_POLL_MS);
  }

  private async sweepInbound(): Promise<void> {
    if (!this.running || !this.loggedIn) return;
    await this.refreshContacts();
    await this.sweepGuildMentions();
    // A crawl that ran before the rail rendered retries, at most once a minute.
    if (
      this.guilds.length > 0 &&
      this.guildChannels.size === 0 &&
      Date.now() - this.lastCrawlAt > 60_000
    )
      await this.crawlGuilds();
    const rows = await this.run<
      Array<{ chatId: string; name: string; text: string; messageId: string }>
    >(INBOUND_SCRIPT, {});
    if (rows == null) return;

    for (const row of rows) {
      // Normalize before anything compares, stores, or shows the text.
      row.text = normalizeScrapedText(row.text);
      const previous = this.lastSeen.get(row.chatId);
      this.lastSeen.set(row.chatId, row.messageId);
      if (this.firstInboundSweep) continue;
      if (previous === row.messageId) continue;
      // Presence previews and our own replies are not inbound messages.
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

  /** Server inbound off the rail's mention pills, visible from any page. */
  private async sweepGuildMentions(): Promise<void> {
    const rows = await this.run<GuildRow[]>(GUILDS_SCRIPT, {});
    if (rows == null) return;
    // An empty read is a rail not yet rendered; keep the last good list.
    if (rows.length > 0) this.guilds = rows.slice(0, MAX_GUILDS);

    for (const guild of rows) {
      if (guild.mentions <= 0) continue;
      const key = `guild:${guild.guildId}`;
      const marker = `${guild.guildId}:${guild.mentions}`;
      const previous = this.lastSeen.get(key);
      this.lastSeen.set(key, marker);
      if (this.firstInboundSweep) continue;
      if (previous === marker) continue;
      this.callbacks.onMessage({
        userId: guild.guildId,
        userName: guild.name,
        chatId: guild.guildId,
        text: `${guild.name} has ${guild.mentions} unread mention(s)`,
      });
    }
  }

  private async refreshContacts(): Promise<void> {
    const rows = await this.run<Array<{ chatId: string; name: string }>>(
      CONTACTS_SCRIPT,
      {}
    );
    // null: off the home page or the script failed; keep the last good rail.
    if (rows == null) return;
    this.contacts = rows;
    this.railReads += 1;
    if (rows.length > 0 || this.railReads >= 2) this.contactsRead = true;
    if (rows.length !== this.loggedContactCount) {
      this.loggedContactCount = rows.length;
      this.callbacks.onLog(
        `discord-web: ${rows.length} DM(s) on the rail, ${this.guilds.length} server(s)`
      );
    }
  }

  /** Scrape each joined server's channels once, so they resolve by name. */
  private async crawlGuilds(): Promise<void> {
    if (!this.running || !this.loggedIn) return;
    this.lastCrawlAt = Date.now();

    // The guild rail renders after the chrome that flips `connected`.
    let guilds: GuildRow[] | null = null;
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      guilds = await this.run<GuildRow[]>(GUILDS_SCRIPT, {});
      if (guilds != null && guilds.length > 0) break;
      await delay(500);
    }
    if (guilds == null || guilds.length === 0) {
      // No servers, or stale rail selectors: the shape line tells them apart.
      if (!this.railShapeLogged) {
        this.railShapeLogged = true;
        const shape = await this.run<Record<string, unknown>>(
          RAIL_SHAPE_SCRIPT,
          {}
        );
        this.callbacks.onLog(
          `discord-web: no servers found, rail shape ${JSON.stringify(shape)}`
        );
      }
      return;
    }
    this.guilds = guilds.slice(0, MAX_GUILDS);

    let channelCount = 0;
    try {
      for (const guild of this.guilds) {
        if (!this.running || !this.loggedIn) return;
        const pressed = await this.run<{ found: boolean }>(OPEN_GUILD_SCRIPT, {
          guildId: guild.guildId,
        });
        if (pressed?.found !== true) {
          const win = this.ensureWindow();
          if (win == null) return;
          await win
            .loadURL(`${DISCORD_ORIGIN}/channels/${guild.guildId}`, {
              userAgent: userAgent(),
            })
            .catch(() => undefined);
        }
        // Collapsed categories keep their channels out of the DOM.
        const expanded = await this.run<{ clicked: number }>(
          EXPAND_CATEGORIES_SCRIPT,
          {}
        );
        if (expanded != null && expanded.clicked > 0) await delay(500);
        const channels = await this.waitForGuildChannels(guild.guildId);
        if (channels.length > 0) {
          this.guildChannels.set(
            guild.guildId,
            channels.slice(0, MAX_CHANNELS_PER_GUILD).map((row) => ({
              chatId: `${guild.guildId}/${row.channelId}`,
              name: `#${row.name} (${guild.name})`,
            }))
          );
          channelCount += Math.min(channels.length, MAX_CHANNELS_PER_GUILD);
        }
      }
    } finally {
      await this.goHome();
    }
    this.callbacks.onLog(
      `discord-web: crawled ${this.guilds.length} server(s), ${channelCount} channel(s)`
    );
  }

  private async waitForGuildChannels(
    guildId: string
  ): Promise<Array<{ channelId: string; name: string }>> {
    const end = Date.now() + 8000;
    while (Date.now() < end) {
      const rows = await this.run<Array<{ channelId: string; name: string }>>(
        GUILD_CHANNELS_SCRIPT,
        { guildId }
      );
      if (rows != null && rows.length > 0) return rows;
      await delay(400);
    }
    return [];
  }

  // ── Page driving ────────────────────────────────────────────────────────

  /** Put the chat on screen: press an in-DOM anchor (SPA hop), else navigate. */
  private async openChat(
    chatId: string
  ): Promise<{ onGuildPage: boolean; ready: boolean }> {
    const win = this.ensureWindow();
    if (win == null || win.isDestroyed())
      throw new Error("Discord is not running.");

    const guildChannel = parseGuildChannel(chatId);
    const isGuild =
      guildChannel == null &&
      isBareId(chatId) &&
      (this.guilds.some((guild) => guild.guildId === chatId) ||
        this.guildChannels.has(chatId));

    let href: string;
    if (guildChannel != null)
      href = `/channels/${guildChannel.guildId}/${guildChannel.channelId}`;
    else if (isGuild) {
      // `/channels/<gid>` may land on the Server Guide, which has no composer;
      // resolve to a text channel from the crawl or the sidebar scraped now.
      let channel = (this.guildChannels.get(chatId) ?? [])[0]?.chatId ?? null;
      if (channel == null) {
        const pressedGuild = await this.run<{ found: boolean }>(
          OPEN_GUILD_SCRIPT,
          { guildId: chatId }
        );
        if (pressedGuild?.found !== true) {
          await win
            .loadURL(`${DISCORD_ORIGIN}/channels/${chatId}`, {
              userAgent: userAgent(),
            })
            .catch(() => undefined);
        }
        const expanded = await this.run<{ clicked: number }>(
          EXPAND_CATEGORIES_SCRIPT,
          {}
        );
        if (expanded != null && expanded.clicked > 0) await delay(500);
        const rows = await this.waitForGuildChannels(chatId);
        if (rows.length > 0) {
          const name =
            this.guilds.find((guild) => guild.guildId === chatId)?.name ??
            chatId;
          this.guildChannels.set(
            chatId,
            rows.slice(0, MAX_CHANNELS_PER_GUILD).map((row) => ({
              chatId: `${chatId}/${row.channelId}`,
              name: `#${row.name} (${name})`,
            }))
          );
          channel = `${chatId}/${rows[0].channelId}`;
        }
      }
      href = channel != null ? `/channels/${channel}` : `/channels/${chatId}`;
    } else if (isBareId(chatId)) href = `/channels/@me/${chatId}`;
    else {
      // A name, not an id: Discord's quickswitcher is its own name lookup.
      const found = await this.run<{ ok: boolean }>(QUICKSWITCH_SCRIPT, {
        target: chatId,
      });
      if (found?.ok !== true)
        throw new Error(`Could not open the Discord chat ${chatId}.`);
      return { onGuildPage: false, ready: await this.waitForChat() };
    }

    const pressed = await this.run<{ found: boolean }>(OPEN_ANCHOR_SCRIPT, {
      href,
    });
    if (pressed?.found !== true) {
      await win
        .loadURL(`${DISCORD_ORIGIN}${href}`, { userAgent: userAgent() })
        .catch(() => undefined);
    }
    // Not ready is not fatal for reads: a forum channel renders neither marker.
    return {
      onGuildPage: guildChannel != null || isGuild,
      ready: await this.waitForChat(),
    };
  }

  private async waitForChat(): Promise<boolean> {
    const end = Date.now() + OPEN_CHAT_TIMEOUT_MS;
    while (Date.now() < end) {
      const state = await this.run<{ ready: boolean }>(CHAT_READY_SCRIPT, {});
      if (state?.ready === true) return true;
      await delay(300);
    }
    return false;
  }

  /** Back to the DM home, where the rail the sweeps read actually exists. */
  private async goHome(): Promise<void> {
    const win = this.window;
    if (win == null || win.isDestroyed()) return;
    const pressed = await this.run<{ found: boolean }>(OPEN_ANCHOR_SCRIPT, {
      href: "/channels/@me",
    });
    if (pressed?.found !== true) {
      await win
        .loadURL(DISCORD_WEB_URL, { userAgent: userAgent() })
        .catch(() => undefined);
    }
    await delay(500);
  }

  private buildWindow(visible: boolean): BrowserWindow {
    const win = new BrowserWindow({
      show: visible,
      width: 1000,
      height: 720,
      title: "Log in to Discord",
      // A child of the app window so it shares the app's Space; a top-level
      // window strands a full-screen user on an empty Space after hide.
      ...(parentWindow() != null ? { parent: parentWindow() } : {}),
      // Not modal (a modal child is a native macOS sheet) and frameless:
      // Esc and the injected Cancel pill are the exit (dismissOnEscape).
      autoHideMenuBar: true,
      frame: false,
      // Painting and unthrottled while hidden, so pointer events at element
      // coordinates and waits on async renders work with no window on screen.
      paintWhenInitiallyHidden: true,
      webPreferences: {
        partition: DISCORD_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.setUserAgent(userAgent());
    // The hidden page would still play Discord's new-message sound.
    win.webContents.setAudioMuted(true);
    // Removed, not auto-hidden: Alt would bring it back. Not on macOS.
    if (process.platform !== "darwin") win.removeMenu();
    dismissOnEscape(win);
    win.on("closed", () => {
      this.window = null;
    });
    return win;
  }

  private ensureWindow(): BrowserWindow | null {
    if (this.window != null && !this.window.isDestroyed()) return this.window;
    if (!this.running) return null;
    // Hidden even when logged out; showLoginWindow reveals it explicitly.
    const win = this.buildWindow(false);
    void win.loadURL(DISCORD_WEB_URL, { userAgent: userAgent() });
    this.window = win;
    return win;
  }

  /**
   * Run one driver script and return its JSON value. An async IIFE, since the
   * scripts use top-level `await`; a throw resolves to null (not-ready).
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
        `discord-web: script failed: ${String((error as Error)?.message ?? error)}`
      );
      return null;
    }
  }
}

/**
 * Logged in only on a positive marker of the signed-in app: a cold load of
 * /channels/@me while logged out sits there before redirecting, and "no login
 * form" would read that boot flash as logged in.
 */
const LOGIN_STATE_SCRIPT = `
  const path = location.pathname;
  const onAuthPage = path.indexOf('/login') === 0 || path.indexOf('/register') === 0;
  const loginForm = !!document.querySelector('input[name="email"], input[type="email"], input[name="password"]');
  if (onAuthPage || loginForm) return { loggedIn: false, loginVisible: true };
  const appChrome =
    !!document.querySelector('a[href="/channels/@me"]') ||
    !!document.querySelector('a[href^="/channels/@me/"]') ||
    !!document.querySelector('[class*="privateChannels"]') ||
    !!document.querySelector('[data-list-id="guildsnav"]');
  return { loggedIn: appChrome, loginVisible: false };
`;

/** The open DMs as contacts. Null off the home page: the rail is a server's. */
const CONTACTS_SCRIPT = `
  if (location.pathname.indexOf('/channels/@me') !== 0) return null;
  const rows = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href^="/channels/@me/"]')) {
    const m = a.getAttribute('href').match(/\\/channels\\/@me\\/(\\d+)/);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const label = a.getAttribute('aria-label') || '';
    const nameEl = a.querySelector('[class*="name"]');
    // The aria-label ends with live presence ("…, Idle"). Strip it, or the
    // same person becomes a new contact every time their status changes.
    const name = (label || (nameEl ? nameEl.textContent : '') || '')
      .replace(/,\\s*(Online|Idle|Do Not Disturb|Offline|Streaming)$/i, '')
      .trim();
    if (name.length === 0) continue;
    rows.push({ chatId: id, name });
    if (rows.length >= 100) break;
  }
  return rows;
`;

/**
 * The joined servers, off the guild rail's `guildsnav___<id>` hook; numeric
 * ids only, which skips the home button, folders and pips.
 */
const GUILDS_SCRIPT = `
  const rows = [];
  const seen = new Set();
  const clean = (raw) => String(raw || '').replace(/,[^,]*(mention|unread)[^,]*$/i, '').trim();
  const badgeIn = (el) => {
    const item = el.closest('[role="treeitem"], [role="listitem"], li') || el.parentElement || el;
    const badge = item ? item.querySelector('[class*="numberBadge"]') : null;
    return badge ? (parseInt(badge.textContent, 10) || 0) : 0;
  };
  const add = (id, raw, mentions) => {
    if (!id || seen.has(id)) return;
    const name = clean(raw);
    if (name.length === 0) return;
    seen.add(id);
    rows.push({ guildId: id, name, mentions: mentions || 0 });
  };
  // The item's own name, never an ancestor's: an unrestricted closest()
  // walk escapes to the rail container, whose label ("Servers") would name
  // every server. data-dnd-name is the guild pill's own attribute; the img
  // alt and the pill's acronym text are the fallbacks.
  const nameOf = (el) => {
    const holder = el.closest('[data-dnd-name]') || el.querySelector('[data-dnd-name]');
    if (holder) {
      const dnd = holder.getAttribute('data-dnd-name');
      if (dnd && dnd.trim().length > 0) return dnd;
    }
    if (el.hasAttribute('aria-label')) return el.getAttribute('aria-label');
    const img = el.querySelector('img[alt]');
    if (img && String(img.getAttribute('alt')).trim().length > 0) return img.getAttribute('alt');
    return el.textContent;
  };
  // The rail's own hook, where it exists.
  for (const el of document.querySelectorAll('[data-list-item-id^="guildsnav___"]')) {
    const m = String(el.getAttribute('data-list-item-id')).match(/^guildsnav___(\\d+)$/);
    if (!m) continue;
    add(m[1], nameOf(el), badgeIn(el));
  }
  // Server icons carry the guild id in their CDN URL. The name comes off the
  // enclosing tree/list item only. A wider [aria-label] ancestor is the whole
  // rail, which would name every server "Servers sidebar".
  for (const img of document.querySelectorAll('img[src*="/icons/"]')) {
    const m = String(img.getAttribute('src')).match(/\\/icons\\/(\\d+)\\//);
    if (!m) continue;
    add(m[1], nameOf(img), badgeIn(img));
  }
  // A rail that links its pips: /channels/<gid> or /channels/<gid>/<cid>.
  for (const a of document.querySelectorAll('a[href^="/channels/"]')) {
    const m = String(a.getAttribute('href')).match(/^\\/channels\\/(\\d+)(?:\\/\\d+)?$/);
    if (!m) continue;
    add(m[1], a.getAttribute('aria-label') || a.textContent, badgeIn(a));
  }
  return rows.slice(0, 100);
`;

/** Rail diagnostics, so the log tells "no servers" from renamed hooks. */
const RAIL_SHAPE_SCRIPT = `
  const sample = [...document.querySelectorAll('[data-list-item-id]')]
    .slice(0, 8)
    .map((el) => el.getAttribute('data-list-item-id'));
  return {
    guildsNav: !!document.querySelector('[data-list-id="guildsnav"]'),
    listItemIds: sample,
    treeItems: document.querySelectorAll('[role="treeitem"]').length,
    guildIcons: document.querySelectorAll('img[src*="/icons/"]').length,
    channelAnchors: document.querySelectorAll('a[href^="/channels/"]').length,
    navs: [...document.querySelectorAll('nav[aria-label]')].map((el) => el.getAttribute('aria-label')).slice(0, 4),
  };
`;

/** The open server's channels, off `/channels/<gid>/<cid>` anchors. */
const GUILD_CHANNELS_SCRIPT = `
  const gid = String(args.guildId || '');
  if (!/^\\d+$/.test(gid)) return [];
  const rows = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href^="/channels/' + gid + '/"]')) {
    const m = a.getAttribute('href').match(/\\/channels\\/\\d+\\/(\\d+)/);
    if (!m) continue;
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const nameEl = a.querySelector('[class*="name"]');
    const label = a.getAttribute('aria-label') || '';
    const name = ((nameEl ? nameEl.textContent : '') || label || '').replace(/^#/, '').trim();
    if (name.length === 0) continue;
    rows.push({ channelId: id, name });
    if (rows.length >= 200) break;
  }
  return rows;
`;

/** Press the anchor whose href starts with args.href, if the page has one. */
const OPEN_ANCHOR_SCRIPT = `
  const press = (el) => {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + Math.min(20, r.width / 2), clientY: r.y + Math.min(20, r.height / 2) };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  };
  const href = String(args.href || '');
  if (href.length === 0) return { found: false };
  const exact = document.querySelector('a[href="' + href + '"]');
  const prefixed = exact || document.querySelector('a[href^="' + href + '/"]');
  if (!prefixed) return { found: false };
  press(prefixed);
  return { found: true };
`;

/** Press a server's icon on the guild rail: an SPA hop into that server. */
const OPEN_GUILD_SCRIPT = `
  const press = (el) => {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + Math.min(20, r.width / 2), clientY: r.y + Math.min(20, r.height / 2) };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  };
  const gid = String(args.guildId || '');
  const el = document.querySelector('[data-list-item-id="guildsnav___' + gid + '"]');
  if (!el) return { found: false };
  press(el);
  return { found: true };
`;

/** Open a chat by name through the quickswitcher, for a non-id target. */
const QUICKSWITCH_SCRIPT = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (sel, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const el = document.querySelector(sel);
      if (el) return el;
      await sleep(120);
    }
    return null;
  };
  const press = (el) => {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + Math.min(20, r.width / 2), clientY: r.y + Math.min(20, r.height / 2) };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  };
  const target = String(args.target || '').trim();
  if (target.length === 0) return { ok: false };
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, metaKey: true, bubbles: true }));
  const qs = await waitFor('[class*="quickswitcher"] input, input[aria-label*="uick"]', 3000);
  if (!qs) return { ok: false };
  qs.focus();
  document.execCommand('insertText', false, target);
  await sleep(700);
  const first = document.querySelector('[id^="quickswitcher-result"], [class*="resultFocused"]');
  if (first) press(first); else qs.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  return { ok: true };
`;

/** Has the opened chat rendered: messages on screen, or at least a composer. */
const CHAT_READY_SCRIPT = `
  const ready =
    !!document.querySelector('li[id^="chat-messages-"]') ||
    !!document.querySelector('div[role="textbox"][data-slate-editor="true"]');
  return { ready };
`;

/** The composer's centre for a trusted click; Slate ignores synthetic input. */
const FOCUS_COMPOSER_SCRIPT = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (sel, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const el = document.querySelector(sel);
      if (el) return el;
      await sleep(120);
    }
    return null;
  };
  const box = await waitFor('div[role="textbox"][data-slate-editor="true"], div[role="textbox"]', 6000);
  if (!box) return { ok: false };
  const r = box.getBoundingClientRect();
  return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
`;

/** Whether the composer currently holds the text we just typed. */
const COMPOSER_HAS_TEXT_SCRIPT = `
  const box = document.querySelector('div[role="textbox"][data-slate-editor="true"], div[role="textbox"]');
  if (!box) return { has: false };
  return { has: box.textContent.indexOf(String(args.probe || '')) !== -1 };
`;

/** Whether the tail of the open chat's message list shows the sent text. */
const LAST_MESSAGES_HAVE_SCRIPT = `
  const probe = String(args.probe || '');
  if (probe.length === 0) return { has: false };
  const items = [...document.querySelectorAll('li[id^="chat-messages-"]')].slice(-5);
  return { has: items.some((li) => li.textContent.indexOf(probe) !== -1) };
`;

/** Page state when a send vanished, so slow mode and wrong page log apart. */
const SEND_FAILURE_SHAPE_SCRIPT = `
  const tail = [...document.querySelectorAll('li[id^="chat-messages-"]')]
    .slice(-3)
    .map((li) => li.textContent.trim().slice(0, 80));
  const alerts = [...document.querySelectorAll('[role="alert"], [class*="errorMessage"], [class*="attachmentError"], [class*="toast"]')]
    .map((el) => el.textContent.trim().slice(0, 120))
    .filter((t) => t.length > 0)
    .slice(0, 3);
  const box = document.querySelector('div[role="textbox"][data-slate-editor="true"], div[role="textbox"]');
  return {
    path: location.pathname,
    tail,
    alerts,
    composer: box ? box.textContent.trim().slice(0, 80) : null,
    placeholder: box && box.getAttribute('aria-label') ? box.getAttribute('aria-label').slice(0, 80) : null,
  };
`;

/** Whether the composer is empty: the confirmation that a send went out. */
const COMPOSER_EMPTY_SCRIPT = `
  const box = document.querySelector('div[role="textbox"][data-slate-editor="true"], div[role="textbox"]');
  if (!box) return { empty: true };
  // Slate keeps a zero-width placeholder in an "empty" editor; treat it as empty.
  // The backslashes are doubled because this is a template literal: written
  // singly, TypeScript reads the escapes itself and the browser receives
  // /[<zero-width><bom>s]/: a regex that strips the letter "s" and leaves
  // whitespace, so a box holding only spaces read as non-empty.
  return { empty: box.textContent.replace(/[\\u200B\\uFEFF\\s]/g, '').length === 0 };
`;

/**
 * The open chat's recent messages. Direction is "out" when the author matches
 * the account panel's username; absent that, everything reads as "in".
 */
const READ_CURRENT_SCRIPT = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const limit = Number(args.limit) || 30;
  // Discord opens a channel at the last-read position, which in a quiet
  // server can be years back. Recent means the bottom; scroll there first.
  const list = document.querySelector('[data-list-id="chat-messages"]') ||
    document.querySelector('li[id^="chat-messages-"]');
  let scroller = list;
  while (scroller && scroller !== document.body) {
    if (scroller.scrollHeight > scroller.clientHeight + 50) break;
    scroller = scroller.parentElement;
  }
  if (scroller === document.body) scroller = null;
  // Who am I? The account panel carries the logged-in username.
  const meEl = document.querySelector('[class*="nameTag"] [class*="username"], [class*="panelTitleContainer"] [class*="text"]');
  const me = meEl ? meEl.textContent.trim() : '';
  // The list is virtualized (items unload as they scroll away), so rows
  // accumulate in a map keyed by message id (snowflakes sort by time).
  const store = new Map();
  const collect = () => {
    const items = [...document.querySelectorAll('li[id^="chat-messages-"]')];
    let lastAuthor = null;
    let lastTime = null;
    for (const li of items) {
      const authorEl = li.querySelector('[id^="message-username-"], [class*="username"]');
      if (authorEl && authorEl.textContent.trim().length > 0) lastAuthor = authorEl.textContent.trim();
      const timeEl = li.querySelector('time');
      if (timeEl && timeEl.getAttribute('datetime')) lastTime = timeEl.getAttribute('datetime');
      const contentEl = li.querySelector('[id^="message-content-"]');
      if (!contentEl) continue;
      const text = contentEl.textContent.trim();
      if (text.length === 0) continue;
      const m = li.id.match(/-(\\d+)$/);
      if (!m) continue;
      store.set(m[1], {
        userName: lastAuthor,
        text,
        direction: me && lastAuthor === me ? 'out' : 'in',
        at: lastTime || '',
      });
    }
  };
  if (scroller) {
    for (let i = 0; i < 4; i++) {
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(250);
    }
  }
  collect();
  // Page up through history until the limit is met or the top is reached.
  if (scroller) {
    for (let i = 0; i < 8 && store.size < limit && scroller.scrollTop > 0; i++) {
      scroller.scrollTop = Math.max(0, scroller.scrollTop - scroller.clientHeight * 2);
      await sleep(400);
      collect();
    }
    // Leave the view at the bottom, where sends and read-backs look.
    scroller.scrollTop = scroller.scrollHeight;
  }
  const mids = [...store.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  return mids.slice(-limit).map((mid) => {
    const row = store.get(mid);
    row.at = row.at || new Date().toISOString();
    return row;
  });
`;

/** DM rail entries with an unread pill, as inbound signal. Home page only. */
const INBOUND_SCRIPT = `
  if (location.pathname.indexOf('/channels/@me') !== 0) return null;
  const rows = [];
  for (const a of document.querySelectorAll('a[href^="/channels/@me/"]')) {
    const m = a.getAttribute('href').match(/\\/channels\\/@me\\/(\\d+)/);
    if (!m) continue;
    const unread = a.querySelector('[class*="unread"], [class*="numberBadge"], [class*="mentionsBadge"]') || a.closest('[class*="unread"]');
    if (!unread) continue;
    const label = a.getAttribute('aria-label') || '';
    const name = label.trim();
    if (name.length === 0) continue;
    rows.push({ chatId: m[1], name, text: name + ' has unread messages', messageId: m[1] + ':' + (unread.textContent || 'u') });
  }
  return rows;
`;

/** A forum's post cards; no message list, so they are the readable content. */
const FORUM_POSTS_SCRIPT = `
  const limit = Number(args.limit) || 30;
  const rows = [];
  const seen = new Set();
  const cards = document.querySelectorAll('[class*="card"], li[class*="post"], [data-item-id]');
  for (const card of cards) {
    const titleEl = card.querySelector('[class*="postTitle"], h3, [class*="title"]');
    // The forum header card wraps its "New Post" button into the heading's
    // text; strip the button label so the card dedupes with the real post.
    const title = (titleEl ? titleEl.textContent.trim() : '').replace(/New Post$/, '').trim();
    if (title.length === 0 || seen.has(title)) continue;
    const snippetEl = card.querySelector('[id^="message-content-"], [class*="messageContent"], [class*="preview"]');
    const snippet = snippetEl ? snippetEl.textContent.trim() : '';
    // A forum post is a thread; its id (off the card's item id or jump
    // link) makes the post readable as guildId/threadId.
    let threadId = '';
    // The id sits on a descendant of the card (or the card itself, or an
    // ancestor, depending on which selector matched the card).
    const holder = card.hasAttribute('data-item-id')
      ? card
      : (card.querySelector('[data-item-id]') || card.closest('[data-item-id]'));
    if (holder) {
      const m = String(holder.getAttribute('data-item-id')).match(/(\\d{15,})/);
      if (m) threadId = m[1];
    }
    if (threadId.length === 0) {
      const a = card.querySelector('a[href*="/channels/"]');
      if (a) {
        const m = a.getAttribute('href').match(/\\/channels\\/\\d+\\/(\\d+)/);
        if (m) threadId = m[1];
      }
    }
    seen.add(title);
    rows.push({ title, snippet: snippet.slice(0, 300), threadId });
    if (rows.length >= limit) break;
  }
  return rows;
`;

/** Page diagnostics, so "channel is empty" and stale selectors log apart. */
const PAGE_SHAPE_SCRIPT = `
  const main = document.querySelector('main') || document.body;
  const sample = [...main.querySelectorAll(':scope > * , :scope > * > *')]
    .slice(0, 10)
    .map((el) => (el.className && el.className.baseVal !== undefined ? el.className.baseVal : String(el.className || '')).split(' ')[0])
    .filter((c) => c.length > 0);
  return {
    path: location.pathname,
    chatItems: document.querySelectorAll('li[id^="chat-messages-"]').length,
    cards: main.querySelectorAll('[class*="card"]').length,
    h3s: main.querySelectorAll('h3').length,
    listItems: main.querySelectorAll('[role="listitem"]').length,
    dataItemIds: main.querySelectorAll('[data-item-id]').length,
    textbox: !!document.querySelector('div[role="textbox"]'),
    classes: sample,
  };
`;

/** Whether an un-sent upload chip is still sitting above the composer. */
const UPLOAD_PENDING_SCRIPT = `
  return { uploading: !!document.querySelector('[class*="attachedFile"], [class*="uploadInput"] + div [class*="file"], form [class*="attachment"]') };
`;

/** Forum card diagnostics, logged when no card yields a thread id. */
const FORUM_SHAPE_SCRIPT = `
  const cards = [...document.querySelectorAll('[class*="card"], li[class*="post"], [data-item-id]')].slice(0, 3);
  return {
    path: location.pathname,
    cards: cards.map((card) => ({
      tag: card.tagName,
      attrs: [...card.attributes].map((a) => a.name + (a.name.indexOf('data-') === 0 ? '=' + String(a.value).slice(0, 40) : '')).slice(0, 10),
      anchors: [...card.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).slice(0, 3),
      parentAttrs: card.parentElement ? [...card.parentElement.attributes].map((a) => a.name + '=' + String(a.value).slice(0, 40)).slice(0, 6) : [],
    })),
    mainAnchors: [...(document.querySelector('main') || document.body).querySelectorAll('a[href*="/channels/"]')].map((a) => a.getAttribute('href')).slice(0, 5),
  };
`;

/** The search bar's centre for a trusted click; it ignores synthetic focus. */
const SEARCH_BAR_POS_SCRIPT = `
  const bar =
    document.querySelector('[class*="searchBar"] [role="combobox"]') ||
    document.querySelector('[class*="searchBar"] [contenteditable="true"]') ||
    document.querySelector('[class*="searchBar"]');
  if (!bar) return { ok: false };
  const r = bar.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { ok: false };
  return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
`;

/** The results pane in document order; channel headers scope the hits after. */
const SEARCH_RESULTS_SCRIPT = `
  const pane = document.querySelector('[class*="searchResultsWrap"]');
  if (!pane) return null;
  const hits = [];
  let current = '';
  for (const el of pane.querySelectorAll('[class*="channelName"], [id^="message-content-"]')) {
    if (el.id && el.id.indexOf('message-content-') === 0) {
      const container = el.closest('li') || el;
      const timeEl = container.querySelector('time');
      // Embeds (bot posts) keep their text outside message-content, so fall
      // back to the whole result item.
      const text = el.textContent.trim() || container.textContent.trim();
      hits.push({
        text: text.slice(0, 300),
        name: current.replace(/^#/, ''),
        when: timeEl ? (timeEl.getAttribute('datetime') || '') : '',
      });
      if (hits.length >= 25) break;
    } else {
      current = el.textContent.trim();
    }
  }
  return { hits };
`;

/** Expand collapsed sidebar sections, whose contents stay out of the DOM. */
const EXPAND_CATEGORIES_SCRIPT = `
  const press = (el) => {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + Math.min(20, r.width / 2), clientY: r.y + Math.min(20, r.height / 2) };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  };
  let clicked = 0;
  for (const el of document.querySelectorAll('nav [role="button"][aria-expanded="false"], nav [aria-expanded="false"][class*="containerDefault"]')) {
    press(el);
    clicked += 1;
    if (clicked >= 20) break;
  }
  return { clicked };
`;
