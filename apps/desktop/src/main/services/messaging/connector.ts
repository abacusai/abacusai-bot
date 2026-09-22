import fs from "fs";
import path from "path";

import type { BrowserWindow } from "electron";

import type {
  MessagingPlatformId,
  MessagingPlatformState,
} from "#shared/messaging";

import { abacusBotHome } from "../../paths";

/**
 * The contract every platform connector implements: receive text, send text,
 * report state. Pairing, routing to an agent session and collecting the reply
 * are platform-independent and live in `messaging-gateway-service.ts`, so a
 * new platform is one of these and nothing else.
 */

/** One inbound message, normalised across platforms. */
export type InboundMessage = {
  /** Platform-native sender id. Stable, and what pairing is keyed on. */
  userId: string;
  userName: string | null;
  /** Where a reply goes. Not always equal to userId (groups, threads, email). */
  chatId: string;
  text: string;
  /**
   * Media that arrived with the message, already saved to disk by the
   * connector; the gateway frames each path into the prompt.
   */
  attachments?: Array<{
    /** Absolute path under the messaging-media directory. */
    path: string;
    /** The sender's filename, or a made-up one for unnamed media. */
    name: string;
    mimeType: string | null;
  }>;
  /** Per-platform context a reply needs: an email Message-ID, a thread_ts. */
  replyContext?: Record<string, string>;
};

export type ConnectorCallbacks = {
  onMessage: (message: InboundMessage) => void;
  onState: (state: MessagingPlatformState, errorMessage?: string) => void;
  /** The platform has just proven which chat is the user's own. */
  onSelfLinked?: () => void;
  /** Diagnostics; surfaced in the main-process log, not the UI. */
  onLog: (line: string) => void;
};

export interface MessagingConnector {
  readonly id: MessagingPlatformId;
  /**
   * Resolves once connected (or the poll loop is running); a later failure is
   * reported through `onState`, not by rejecting.
   */
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Re-read the login state from the platform right now and report any change
   * through `onState`. Optional: web-driven connectors answer off their page;
   * token platforms have nothing fresher than their socket.
   */
  probeLive?(): Promise<boolean>;
  sendText(
    chatId: string,
    text: string,
    replyContext?: Record<string, string>
  ): Promise<void>;
  /**
   * The platform's address book, for "send this to Mom". Optional: token
   * platforms know nobody until somebody writes in, which pairing covers.
   */
  listContacts?(): Array<{ chatId: string; name: string; isGroup?: boolean }>;
  /**
   * Chats with messages waiting, read fresh from the platform's own store.
   * Optional: a scrape of unread badges is a guess, and this must not be one.
   * Throws when the platform cannot say right now.
   */
  unreadChats?(): Promise<
    Array<{ chatId: string; name: string; unreadCount: number }>
  >;
  /**
   * The chat id that means "me" on this platform. Null until connected; the
   * one address the user must never be asked for, since connecting set it.
   */
  selfChatId?(): string | null;
  /**
   * Whether the chat list has actually been read. A page reports `connected`
   * before its DM rail renders, so the gateway treats a connected platform as
   * still starting until this says otherwise.
   */
  contactsReady?(): boolean;
  /**
   * A chat's real recent history, opening it if need be. The gateway's log
   * only holds what arrived while the app ran; optional because only a live
   * client can answer, and the gateway falls back to its log.
   */
  readChat?(
    chatId: string,
    limit: number
  ): Promise<
    Array<{
      userName: string | null;
      text: string;
      direction: "in" | "out";
      at: string;
    }>
  >;
  /**
   * Search the platform's own history by message content ("which chat
   * mentioned X?" when no name lookup lands). Returns matching chats with a
   * snippet each: a pointer for readChat, not the thread. `scope` narrows to
   * one chat where search is per-chat (Discord); global search ignores it.
   */
  searchMessages?(
    query: string,
    limit: number,
    scope?: string
  ): Promise<
    Array<{ chatId: string; name: string; snippet: string; when: string }>
  >;
  /**
   * Send a file with an optional caption. Optional: a platform without it
   * answers the tool with a clear "not supported here".
   */
  sendFile?(chatId: string, filePath: string, caption?: string): Promise<void>;
}

/** Files larger than this are refused rather than half-uploaded. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Save inbound media under `messaging-media/<platform>/<chat>/<stamp>-<name>`
 * in the app home. Chat ids are display names on the web platforms, so they
 * are sanitized rather than trusted; the stamp keeps a chat's fifth photo.jpg
 * from overwriting its first.
 */
export const saveInboundMedia = (
  platform: MessagingPlatformId,
  chatId: string,
  name: string,
  data: Buffer
): string => {
  const safeChat =
    chatId
      .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
      .trim()
      .slice(0, 60) || "chat";
  const safeName =
    path
      .basename(name)
      .replace(/[^\p{L}\p{N}._ -]+/gu, "_")
      .slice(0, 80) || "file";
  const dir = path.join(abacusBotHome(), "messaging-media", platform, safeChat);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${safeName}`);
  fs.writeFileSync(file, data);
  return file;
};

/**
 * Reconnect backoff for the socket connectors, capped at 60s and jittered so
 * every running copy does not retry a platform in lockstep after an outage.
 */
export const backoffDelayMs = (attempt: number): number => {
  const base = Math.min(60_000, 1_000 * 2 ** Math.min(attempt, 6));
  return base / 2 + Math.random() * (base / 2);
};

/**
 * Split a reply to fit a platform's message cap, preferring paragraph then line
 * boundaries so a long agent answer doesn't get cut mid-word.
 */
export const chunkMessage = (text: string, limit: number): string[] => {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // Prefer the last paragraph break, then the last line break, then a hard
    // cut. `lastIndexOf` on the window means we never split past the limit.
    const breakAt = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n")
    );
    const cut = breakAt > limit * 0.5 ? breakAt : limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  if (rest.length > 0) chunks.push(rest);
  return chunks;
};

/**
 * Chat-list previews that are presence, not messages: "typing…" would
 * otherwise hand the agent a message nobody sent. English-only; the strings
 * match WhatsApp Web's own locale.
 */
export const isEphemeralPreview = (text: string): boolean =>
  /^(typing|recording audio|recording video|online)(…|\.\.\.)?$/i.test(
    text.trim()
  );

/**
 * The "Alice: " a group preview opens with ("You: " for ours). Bounded and
 * colon-terminated so it takes a speaker, not "Reminder: pick up the keys".
 */
const SPEAKER_PREFIX = /^[^:\n]{1,40}:\s+/;

/**
 * Is this chat-list preview the tail of something we just sent there? A
 * preview sweep cannot tell direction, so our own reply would be read back in
 * and answered. The preview truncates with an ellipsis, so the comparison is
 * prefix-tolerant in both directions.
 */
export const previewMatchesSent = (
  sent: readonly string[] | string | undefined,
  preview: string
): boolean => {
  if (sent == null) return false;
  const clipped = normalizeScrapedText(preview).replace(/…$/, "").trim();
  if (clipped.length === 0) return false;

  // A group preview names its speaker ("You: on my way"), so the raw text
  // matches nothing we sent and the bot would answer itself. Compare with the
  // speaker dropped too; another sender's text stays unmatched without it.
  const candidates = [clipped, clipped.replace(SPEAKER_PREFIX, "")];

  const own = typeof sent === "string" ? [sent] : sent;
  return own.some((entry) => {
    const text = normalizeScrapedText(entry);
    if (text.length === 0) return false;
    return candidates.some(
      (candidate) =>
        candidate.length > 0 &&
        (text.startsWith(candidate) || candidate.startsWith(text))
    );
  });
};

/**
 * Marks text this app sent into a chat where its own messages read back as
 * the user's (WhatsApp's "Message yourself"), so two installs on one phone
 * do not answer each other. Zero-width, and stripped by normalizeScrapedText,
 * so the check must run on the RAW text.
 */
export const BOT_SIGNATURE = "\u2063\u200b\u2063";

/**
 * Did an AbacusBot write this? Our signature, or the auto-reply protocol's
 * tags and preamble leaking from a build that does not strip them.
 */
export const looksLikeBotOutput = (raw: string): boolean =>
  raw.includes(BOT_SIGNATURE) ||
  /<\/?reply>/i.test(raw) ||
  raw.includes("[auto-reply]");

/**
 * One normalization for everything scraped out of a chat app's DOM: bidi
 * embedding marks, zero-width and word-joiner characters, and whitespace runs
 * that were never typed. Every connector runs scraped text through here
 * before anything compares, stores, or shows it.
 */
export const normalizeScrapedText = (text: string): string =>
  text
    // Bidi controls, zero-width spaces/joiners, word joiner, BOM.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();

/**
 * Put a real file into a page's `<input type="file">`. A file picker is native
 * UI no click can drive, so this uses the debugger's `DOM.setFileInputFiles`.
 * Attached per call and detached after; a debugger someone else attached is
 * reused and left alone.
 */
export const setFileInput = async (
  win: BrowserWindow,
  selector: string,
  filePath: string
): Promise<void> => {
  const dbg = win.webContents.debugger;
  const attachedHere = !dbg.isAttached();
  if (attachedHere) dbg.attach("1.3");
  try {
    const { root } = (await dbg.sendCommand("DOM.getDocument")) as {
      root: { nodeId: number };
    };
    const { nodeId } = (await dbg.sendCommand("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    })) as { nodeId: number };
    if (nodeId === 0)
      throw new Error(`No file input on the page matched ${selector}.`);
    await dbg.sendCommand("DOM.setFileInputFiles", {
      nodeId,
      files: [filePath],
    });
  } finally {
    if (attachedHere) dbg.detach();
  }
};
