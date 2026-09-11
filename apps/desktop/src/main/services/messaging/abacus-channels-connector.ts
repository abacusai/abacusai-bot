import { BrowserWindow } from "electron";
import QRCode from "qrcode";

import type { MessagingPlatformId, SharedChannelLink } from "#shared/messaging";

import { parentWindow } from "../../bring-to-front";
import { resolveAbacusApiKey } from "../providers/abacus";
import { abacusRoutellmV1, abacusUserAgent } from "../providers/abacus-host";
import {
  chunkMessage,
  saveInboundMedia,
  type ConnectorCallbacks,
  type MessagingConnector,
} from "./connector";
import { DISCORD_PARTITION } from "./discord-web-connector";

/**
 * Discord or Telegram through the shared "Abacus AI" bots. The platform owns
 * the bot; the user pairs once (`/link <code>` on Discord, Start on a t.me
 * link for Telegram) and their messages to it are routed here. Transport is a
 * long-poll of `/v1/abacusaibot_channels` with the app's Abacus key; replies
 * go back against a server-minted message id, so the app never names a
 * Discord channel itself.
 */

/** Each platform's own message cap. */
const MAX_MESSAGE_LENGTH: Record<SharedChannel, number> = {
  discord: 2000,
  telegram: 4000,
};
/** The server holds an inbox poll open for at most this long. */
const INBOX_WAIT_SECS = 25;
/** How often the pairing card re-asks "linked yet?" while a code is up. */
const PAIR_POLL_MS = 3000;
export type SharedChannel = "discord" | "telegram";

const isSharedChannel = (value: unknown): value is SharedChannel =>
  value === "discord" || value === "telegram";
/** The one chat this platform has: the user's own conversation with the bot. */
export const SELF_CHAT_ID = "me";

type InboxEntry = {
  id: string;
  ts: number;
  channel: string;
  sender: string | null;
  text: string;
  /** Small files (a Telegram photo) ride inline from the server. */
  attachments?: Array<{
    name?: string;
    mime?: string;
    data_b64?: string;
  }>;
};

type StatusResponse = {
  channels?: Record<string, { status?: string; display_name?: string | null }>;
  available?: string[];
  /** The bots' display names, as their chats are titled. */
  discord_app_name?: string;
  telegram_bot_name?: string | null;
  telegram_bot_username?: string | null;
};

type PairResponse = {
  status?: string;
  deep_link?: string;
  code?: string;
  instructions?: string;
  expires_at?: number;
  display_name?: string | null;
  /** What to encode as a QR when the link is meant for a phone. */
  qr_data?: string;
};

export const isWebUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
};

/**
 * Refuse every way off the web from inside the window: Discord's authorize
 * page hands off to `discord://` when it thinks an app is there, and popups
 * would become an OS call. Both stay on the page's own web fallback.
 */
export const keepOnTheWeb = (win: BrowserWindow): void => {
  const contents = win.webContents;
  const refuseOffWeb = (event: { preventDefault: () => void }, url: string) => {
    if (!isWebUrl(url)) event.preventDefault();
  };
  contents.on("will-navigate", refuseOffWeb);
  contents.on("will-redirect", refuseOffWeb);
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void contents.loadURL(url);
    return { action: "deny" };
  });
};

/**
 * The running lane for each channel. The inbox is per account, not per
 * channel, so whichever lane's poll fetches an entry must hand it to the lane
 * its channel names, or a Telegram message gets answered as Discord.
 */
const lanes = new Map<SharedChannel, AbacusChannelsConnector>();

export class AbacusChannelsConnector implements MessagingConnector {
  readonly id: MessagingPlatformId;

  private running = false;
  private linked = false;
  private link: SharedChannelLink = { status: "unlinked" };
  private botName: string | null = null;
  private pairTimer: NodeJS.Timeout | null = null;
  private abort: AbortController | null = null;
  private linkWindow: BrowserWindow | null = null;

  constructor(
    private readonly callbacks: ConnectorCallbacks,
    private readonly channel: SharedChannel = "discord"
  ) {
    this.id = `abacus_${channel}`;
  }

  /** What the settings card shows: linked, a pending code, or the way in. */
  sharedLink(): SharedChannelLink {
    return this.link;
  }

  selfChatId(): string | null {
    return this.linked ? SELF_CHAT_ID : null;
  }

  /** How the bot appears in the chat app, once linked — the name its chat carries. */
  sharedBotName(): string | null {
    return this.linked ? this.botName : null;
  }

  contactsReady(): boolean {
    return true;
  }

  async start(): Promise<void> {
    this.running = true;
    lanes.set(this.channel, this);
    this.callbacks.onState("connecting");
    await this.refreshStatus();
    void this.pollLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (lanes.get(this.channel) === this) lanes.delete(this.channel);
    this.clearPairTimer();
    this.abort?.abort();
    this.abort = null;
    if (this.linkWindow != null && !this.linkWindow.isDestroyed())
      this.linkWindow.close();
    this.linkWindow = null;
  }

  async sendText(
    chatId: string,
    text: string,
    replyContext?: Record<string, string>
  ): Promise<void> {
    if (chatId !== SELF_CHAT_ID)
      throw new Error(
        "The Abacus AI bot only talks to you — it cannot message other people."
      );
    for (const chunk of chunkMessage(text, MAX_MESSAGE_LENGTH[this.channel])) {
      const messageId = replyContext?.message_id;
      const result = await this.call<{ ok?: boolean; error?: string }>(
        messageId != null
          ? { action: "reply", message_id: messageId, text: chunk }
          : { action: "send", channel: this.channel, text: chunk }
      );
      if (result.ok !== true)
        throw new Error(
          result.error ?? `${this.channel} did not accept the message`
        );
    }
  }

  // ── Pairing ───────────────────────────────────────────────────────────────

  /** Mint a pairing code and start watching for the user to redeem it. */
  async pair(): Promise<SharedChannelLink> {
    const result = await this.call<PairResponse>({
      action: "pair",
      channel: this.channel,
    });
    if (result.status === "linked") {
      this.markLinked(result.display_name ?? null);
      return this.link;
    }
    // Telegram's start link is scanned by a phone camera; Discord's install
    // link is a click, and its code is typed, so it gets no QR.
    const qrDataUrl =
      this.channel === "telegram" && result.qr_data != null
        ? await QRCode.toDataURL(result.qr_data, { margin: 1, width: 240 })
        : undefined;
    // The app's profile page is where its DM is one click away: Discord hides
    // a user-installed app from the DM list and search until it is messaged.
    const clientId =
      this.channel === "discord" && result.deep_link != null
        ? /[?&]client_id=(\d+)/.exec(result.deep_link)?.[1]
        : undefined;
    this.setLink({
      status: "pending",
      deepLink: result.deep_link,
      botProfileUrl:
        clientId != null ? `https://discord.com/users/${clientId}` : undefined,
      code: this.channel === "discord" ? result.code : undefined,
      instructions: result.instructions,
      expiresAt: result.expires_at,
      qrDataUrl,
    });
    this.callbacks.onState(
      "needs_login",
      this.channel === "discord"
        ? "Waiting for the /link command in Discord."
        : "Waiting for Start to be tapped in Telegram."
    );
    this.watchPairing();
    return this.link;
  }

  /**
   * Open the install link in a window of the app's own: handed to the OS, a
   * discord.com link routes to the Discord desktop app, which takes over the
   * authorize flow. Shares the web connector's session so a sign-in carries.
   */
  openLink(target: "install" | "dm" = "install"): void {
    const url =
      this.link.status === "pending"
        ? target === "dm"
          ? this.link.botProfileUrl
          : this.link.deepLink
        : undefined;
    if (url == null || !isWebUrl(url))
      throw new Error("There is no install link to open — press Link first.");
    if (this.linkWindow != null && !this.linkWindow.isDestroyed()) {
      void this.linkWindow.loadURL(url);
      this.linkWindow.show();
      this.linkWindow.focus();
      return;
    }
    // Discord's app-profile card needs a desktop-width viewport; same size as
    // the sign-in window, so the two read as one flow.
    const win = new BrowserWindow({
      width: 1000,
      height: 720,
      title: "Add Abacus AI to Discord",
      ...(parentWindow() != null ? { parent: parentWindow() } : {}),
      autoHideMenuBar: true,
      webPreferences: {
        partition: DISCORD_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    keepOnTheWeb(win);
    win.webContents.setAudioMuted(true);
    win.on("closed", () => {
      this.linkWindow = null;
    });
    this.linkWindow = win;
    void win.loadURL(url);
  }

  async unlink(): Promise<SharedChannelLink> {
    this.clearPairTimer();
    await this.call({ action: "unlink", channel: this.channel });
    this.linked = false;
    this.setLink({ status: "unlinked" });
    this.callbacks.onState(
      "needs_login",
      "Not linked to the Abacus AI bot yet."
    );
    return this.link;
  }

  private watchPairing(): void {
    this.clearPairTimer();
    const tick = async (): Promise<void> => {
      this.pairTimer = null;
      if (!this.running || this.link.status !== "pending") return;
      // A code that ran out while the user was still finding their phone is
      // replaced rather than reported. The server sets the lifetime and will
      // not honour a stale code, so the pane cannot simply keep showing this
      // one — but "that code expired, link again" asks the user to redo by
      // hand what the app can do for them, and the QR they are looking at
      // becomes a QR that silently does nothing.
      if (
        this.link.expiresAt != null &&
        Date.now() / 1000 > this.link.expiresAt
      ) {
        try {
          // pair() starts the watch again, so this tick is done: scheduling
          // another below would leave two loops polling the same link.
          await this.pair();
          this.callbacks.onLog(
            `${this.channel}: the pairing code ran out — showing a fresh one`
          );
          return;
        } catch (error) {
          this.setLink({
            status: "unlinked",
            error: `That code expired, and a new one could not be minted: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          return;
        }
      }
      await this.refreshStatus();
      if (this.link.status === "pending") {
        this.pairTimer = setTimeout(() => void tick(), PAIR_POLL_MS);
        this.pairTimer.unref?.();
      }
    };
    this.pairTimer = setTimeout(() => void tick(), PAIR_POLL_MS);
    this.pairTimer.unref?.();
  }

  private clearPairTimer(): void {
    if (this.pairTimer != null) clearTimeout(this.pairTimer);
    this.pairTimer = null;
  }

  private async refreshStatus(): Promise<void> {
    let status: StatusResponse;
    try {
      status = await this.call<StatusResponse>({ action: "status" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.callbacks.onState("error", message);
      return;
    }
    if (!(status.available ?? []).includes(this.channel)) {
      this.setLink({
        status: "unavailable",
        error: `The Abacus AI ${this.channel} bot is not available on this account yet.`,
      });
      this.callbacks.onState("error", this.link.error);
      return;
    }
    const botName =
      this.channel === "discord"
        ? status.discord_app_name
        : (status.telegram_bot_name ?? status.telegram_bot_username);
    if (typeof botName === "string" && botName.length > 0)
      this.botName = botName;
    const channel = status.channels?.[this.channel];
    if (channel?.status === "linked") {
      this.markLinked(channel.display_name ?? null);
      return;
    }
    if (this.link.status !== "pending") this.setLink({ status: "unlinked" });
    this.linked = false;
    this.callbacks.onState(
      "needs_login",
      "Not linked to the Abacus AI bot yet."
    );
  }

  private markLinked(displayName: string | null): void {
    const wasLinked = this.linked;
    this.linked = true;
    this.clearPairTimer();
    // Left open, the install window sits over the app saying nothing.
    if (!wasLinked && this.linkWindow != null && !this.linkWindow.isDestroyed())
      this.linkWindow.close();
    this.setLink({ status: "linked", displayName });
    this.callbacks.onState("connected");
    if (!wasLinked) this.callbacks.onSelfLinked?.();
  }

  private setLink(link: SharedChannelLink): void {
    this.link = link;
  }

  // ── Inbound ───────────────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      if (!this.linked) {
        await this.sleep(PAIR_POLL_MS);
        continue;
      }
      try {
        // The channel is a hint for a server that filters by it; routing
        // below does not rely on it.
        const result = await this.call<{ messages?: InboxEntry[] }>(
          { action: "inbox", wait: INBOX_WAIT_SECS, channel: this.channel },
          (INBOX_WAIT_SECS + 15) * 1000
        );
        failures = 0;
        for (const entry of result.messages ?? []) this.route(entry);
      } catch (error) {
        if (!this.running) return;
        failures += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.callbacks.onLog(`${this.id}: inbox poll failed — ${message}`);
        if (failures >= 3) this.callbacks.onState("error", message);
        await this.sleep(Math.min(1000 * 2 ** failures, 60_000));
        if (this.running && failures >= 3) await this.refreshStatus();
      }
    }
  }

  /** Hand an entry to the lane its channel names; this one when it is ours. */
  private route(entry: InboxEntry): void {
    const channel = isSharedChannel(entry.channel) ? entry.channel : null;
    if (channel == null || channel === this.channel) {
      this.deliver(entry);
      return;
    }
    const lane = lanes.get(channel);
    if (lane != null && lane.running) {
      lane.deliver(entry);
      return;
    }
    // No lane for this channel: a lost message is worse than a mislabelled
    // one, so deliver here and say so.
    this.callbacks.onLog(
      `${this.id}: a ${channel} message arrived with no ${channel} lane running — delivered here`
    );
    this.deliver(entry);
  }

  private deliver(entry: InboxEntry): void {
    if (typeof entry.text !== "string" || entry.text.length === 0) return;
    // Inline files land in the messaging media folder so the agent can open them.
    const attachments = (entry.attachments ?? []).flatMap((file) => {
      if (file.data_b64 == null || file.data_b64.length === 0) return [];
      try {
        const path = saveInboundMedia(
          this.id,
          SELF_CHAT_ID,
          file.name ?? "file",
          Buffer.from(file.data_b64, "base64")
        );
        return [
          { path, name: file.name ?? "file", mimeType: file.mime ?? null },
        ];
      } catch (error) {
        this.callbacks.onLog(
          `abacus-${this.channel}: could not save an attachment — ${error instanceof Error ? error.message : String(error)}`
        );
        return [];
      }
    });
    this.callbacks.onMessage({
      userId: SELF_CHAT_ID,
      userName: entry.sender ?? null,
      chatId: SELF_CHAT_ID,
      text: entry.text,
      ...(attachments.length > 0 ? { attachments } : {}),
      replyContext: { message_id: entry.id },
    });
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  private async call<T>(
    body: Record<string, unknown>,
    timeoutMs = 20_000
  ): Promise<T> {
    // The app requires an Abacus sign-in, so a missing key is a fault, not a state.
    const key = resolveAbacusApiKey();
    if (key == null) throw new Error("Abacus.AI is not connected.");
    const controller = new AbortController();
    this.abort = controller;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(
        `${abacusRoutellmV1()}/abacusaibot_channels`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            "user-agent": abacusUserAgent(),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }
      );
      const payload = (await response.json().catch(() => ({}))) as T & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(
          payload.error ?? `Abacus API returned ${response.status}`
        );
      return payload;
    } finally {
      clearTimeout(timer);
      if (this.abort === controller) this.abort = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}
