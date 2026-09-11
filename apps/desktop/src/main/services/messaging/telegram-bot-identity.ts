import fs from "fs";
import path from "path";

import { abacusBotHome } from "../../paths";

/**
 * The agent's own Telegram identity: a Bot API bot the connector provisions by
 * chatting with @BotFather over the user's web session, so connect stays "scan
 * a QR". The web session reads chats (only the account can); the bot is the
 * assistant's voice to the user and the remote-control channel. This file owns
 * the durable state, BotFather reply parsing and the Bot API long-poll.
 */

/** Bot API messages cap at 4096 chars; stay under it like the web sender. */
export const BOT_MAX_MESSAGE_LENGTH = 4000;

/**
 * Persisted identity: `~/.abacusai-bot/telegram-bot.json`. Its own 0600 file,
 * written only by the main process, so the renderer's credential IPC can
 * neither read nor overwrite the token.
 */
export type TelegramBotState = {
  token?: string;
  /** The bot's public @username (without the @). */
  username?: string;
  /** The user's own chat with the bot — what "send this to me" resolves to. */
  selfChatId?: string;
};

const statePath = (): string => path.join(abacusBotHome(), "telegram-bot.json");

export const readTelegramBotState = (): TelegramBotState => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    return parsed != null && typeof parsed === "object"
      ? (parsed as TelegramBotState)
      : {};
  } catch {
    return {};
  }
};

export const saveTelegramBotState = (
  patch: Partial<TelegramBotState>
): TelegramBotState => {
  const next = { ...readTelegramBotState(), ...patch };
  const target = statePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Temp + rename with the mode set before the file is visible — the same
  // treatment messaging.json gets, for the same reason: this holds a secret.
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // Windows and some network filesystems have no POSIX modes; the file
    // still lives under the user's home.
  }
  fs.renameSync(tmp, target);
  return next;
};

/** The environment wins over the stored token, as it does for every secret. */
export const resolveBotToken = (state: TelegramBotState): string | null => {
  const fromEnv = process.env.TELEGRAM_BOT_TOKEN;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0)
    return fromEnv.trim();
  return state.token != null && state.token.length > 0 ? state.token : null;
};

// ── BotFather reply parsing ────────────────────────────────────────────────

/**
 * The token out of BotFather's "Done!" message. Anchored on the token's shape
 * (`<numeric id>:<35-ish base64url chars>`), not the prose it rewords.
 */
export const parseBotFatherToken = (text: string): string | null => {
  const match = /\b(\d{6,}:[A-Za-z0-9_-]{30,})\b/.exec(text);
  return match?.[1] ?? null;
};

/** BotFather turning a username down — taken, malformed, or too short. */
export const isUsernameRejected = (text: string): boolean =>
  parseBotFatherToken(text) == null &&
  /taken|invalid|must end|sorry|can't|cannot/i.test(text);

/**
 * Telegram requires 5-32 chars ending in "bot", globally unique: a readable
 * prefix carries the identity and the random tail carries the uniqueness.
 */
export const botUsernameCandidate = (): string =>
  `AbacusAI${Math.random().toString(36).slice(2, 8)}Bot`;

// ── Bot API ────────────────────────────────────────────────────────────────

type BotApiMessage = {
  message_id?: number;
  text?: string;
  caption?: string;
  /** Sizes of one photo, smallest first; the last is the full resolution. */
  photo?: Array<{ file_id?: string; file_size?: number }>;
  document?: {
    file_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  voice?: { file_id?: string; mime_type?: string; file_size?: number };
  chat?: { id?: number; type?: string };
  from?: {
    id?: number;
    is_bot?: boolean;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
  reply_to_message?: {
    from?: { is_bot?: boolean; username?: string };
  };
};

export type BotUpdate = { update_id: number; message?: BotApiMessage };

export type BotInbound = {
  userId: string;
  userName: string | null;
  chatId: string;
  text: string;
  /** Media on the message, still on Telegram's servers — see downloadFile. */
  media?: Array<{ fileId: string; name: string; mimeType: string | null }>;
  /**
   * The parameter of a `/start <payload>` message, i.e. the `?start=` value of
   * a deep link; a /start carrying our nonce can only come from our own link.
   */
  startPayload?: string;
};

/**
 * One update normalised to the connector's inbound shape, or null for what the
 * gateway must not see: other bots (two bots answering each other is a loop
 * with a bill), empty payloads, channels. A group message passes only when it
 * @mentions or replies to the bot, mention stripped; checked here rather than
 * trusting BotFather's privacy mode, which someone can flip. Sender gating
 * stays with the gateway.
 */
export const updateToInbound = (
  update: BotUpdate,
  botUsername?: string | null
): BotInbound | null => {
  const message = update.message;
  const chatId = message?.chat?.id;
  const from = message?.from;

  // Media first: a photo or document is a message even with no words on it.
  const media: NonNullable<BotInbound["media"]> = [];
  const photo = message?.photo?.at(-1);
  if (photo?.file_id != null)
    media.push({
      fileId: photo.file_id,
      name: "photo.jpg",
      mimeType: "image/jpeg",
    });
  if (message?.document?.file_id != null)
    media.push({
      fileId: message.document.file_id,
      name: message.document.file_name ?? "document",
      mimeType: message.document.mime_type ?? null,
    });
  if (message?.voice?.file_id != null)
    media.push({
      fileId: message.voice.file_id,
      name: "voice.ogg",
      mimeType: message.voice.mime_type ?? null,
    });

  let text = message?.text ?? message?.caption ?? "";
  if (
    (text.length === 0 && media.length === 0) ||
    chatId == null ||
    from?.id == null
  )
    return null;
  if (from.is_bot === true) return null;

  const chatType = message?.chat?.type;
  if (chatType !== "private") {
    if (chatType !== "group" && chatType !== "supergroup") return null;
    if (botUsername == null || botUsername.length === 0) return null;

    const mention = new RegExp(`@${botUsername}\\b`, "gi");
    const isReplyToBot =
      message?.reply_to_message?.from?.is_bot === true &&
      message.reply_to_message.from.username?.toLowerCase() ===
        botUsername.toLowerCase();

    if (!mention.test(text) && !isReplyToBot) return null;

    text = text.replace(mention, "").replace(/\s+/g, " ").trim();
    if (text.length === 0 && media.length === 0) return null;
  }

  const name = [from.first_name, from.last_name]
    .filter((part): part is string => part != null && part.length > 0)
    .join(" ");
  const startPayload = /^\/start\s+(\S+)\s*$/.exec(text)?.[1];
  return {
    userId: String(from.id),
    userName: name.length > 0 ? name : (from.username ?? null),
    chatId: String(chatId),
    text,
    ...(media.length > 0 ? { media } : {}),
    ...(startPayload != null ? { startPayload } : {}),
  };
};

/** The Bot API long-poll and sender. Dependency-free: plain JSON over fetch. */
export class TelegramBotPoller {
  private running = false;
  private offset = 0;
  /** Learned by getMe; group mentions cannot be recognised until it is. */
  private username: string | null = null;

  constructor(
    private readonly token: string,
    private readonly callbacks: {
      onMessage: (message: BotInbound) => void;
      onLog: (line: string) => void;
    }
  ) {}

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  /**
   * The bot's numeric peer id from the token (`<id>:<secret>`): the id
   * telegram-web-k knows the bot's chat by, which the self-link checks against.
   */
  get botId(): string {
    return this.token.split(":")[0] ?? "";
  }

  /** Validate the token and learn the bot's username. Throws on a bad token. */
  async getMe(): Promise<{ username: string }> {
    const response = await fetch(this.url("getMe"));
    const body = (await response.json()) as {
      ok?: boolean;
      result?: { username?: string };
      description?: string;
    };
    if (body.ok !== true || body.result?.username == null)
      throw new Error(body.description ?? "Telegram rejected the bot token.");
    this.username = body.result.username;
    return { username: body.result.username };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  /** Two hops by API design: getFile answers with a short-lived path, and the
   * bytes live under /file/. */
  async downloadFile(fileId: string): Promise<Buffer> {
    const meta = await fetch(
      `${this.url("getFile")}?file_id=${encodeURIComponent(fileId)}`
    );
    const body = (await meta.json()) as {
      ok?: boolean;
      result?: { file_path?: string };
      description?: string;
    };
    if (body.ok !== true || body.result?.file_path == null)
      throw new Error(body.description ?? "Telegram could not serve the file.");
    const data = await fetch(
      `https://api.telegram.org/file/bot${this.token}/${body.result.file_path}`
    );
    if (!data.ok) throw new Error(`Telegram file fetch failed: ${data.status}`);
    return Buffer.from(await data.arrayBuffer());
  }

  async sendFile(
    chatId: string,
    filePath: string,
    caption?: string
  ): Promise<void> {
    const fs = await import("fs");
    const path = await import("path");
    const buffer = fs.readFileSync(filePath);
    const name = path.basename(filePath);
    const form = new FormData();
    form.set("chat_id", chatId);
    if (caption != null && caption.length > 0)
      form.set("caption", caption.slice(0, 1024));
    form.set(
      "document",
      new Blob([new Uint8Array(buffer)]),
      name.length > 0 ? name : "file"
    );
    const response = await fetch(this.url("sendDocument"), {
      method: "POST",
      body: form,
    });
    const body = (await response.json()) as {
      ok?: boolean;
      description?: string;
    };
    if (body.ok !== true)
      throw new Error(body.description ?? "Telegram could not send the file.");
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const response = await fetch(this.url("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const body = (await response.json()) as {
      ok?: boolean;
      description?: string;
    };
    if (body.ok !== true)
      throw new Error(
        body.description ?? "Telegram could not send the bot message."
      );
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const response = await fetch(
          `${this.url("getUpdates")}?timeout=25&offset=${this.offset}&allowed_updates=%5B%22message%22%5D`
        );
        const body = (await response.json()) as {
          ok?: boolean;
          result?: BotUpdate[];
        };
        if (body.ok !== true) throw new Error("getUpdates not ok");
        for (const update of body.result ?? []) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          const inbound = updateToInbound(update, this.username);
          if (inbound != null) this.callbacks.onMessage(inbound);
        }
      } catch (error) {
        if (!this.running) return;
        this.callbacks.onLog(
          `telegram-bot: poll failed, retrying: ${String((error as Error)?.message ?? error)}`
        );
        // One breath before retrying; getUpdates itself long-polls for 25s,
        // so this only paces the failure case.
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  }
}
