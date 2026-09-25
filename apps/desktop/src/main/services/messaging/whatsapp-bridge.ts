import fs from "fs";

import { resourcePath } from "../../resources";

/**
 * WhatsApp through its own store, not its pixels: wa-js (wppconnect-team,
 * Apache-2.0) injected into the page gives identity, sends with a server ack,
 * and an event per inbound message. The DOM driver is the fallback when it
 * cannot attach, never for identity and never to report a send as done.
 */

/** What `readChat` answers: the messages, or why the chat was out of reach. */
export type BridgeRead =
  | { ok: true; rows: BridgeMessage[] }
  | { ok: false; reason: string };

export type BridgeChat = {
  jid: string;
  name: string;
  isGroup: boolean;
  /** WhatsApp's own flag for the user's "Message yourself" chat. */
  isMe: boolean;
  /** Negative means the user marked the chat unread by hand. */
  unreadCount: number;
};

export type BridgeMessage = {
  id: string;
  jid: string;
  fromMe: boolean;
  senderName: string | null;
  text: string;
  /** Unix seconds, as WhatsApp stores it. */
  t: number;
  /** WhatsApp's own word that the chat is the user's own; absent, not
   * guessed, when the page could not say. */
  chatIsMe?: boolean;
};

export type BridgeSendResult = {
  id: string;
  /** -1 error, 0 pending on this device, 1 server, 2 delivered, 3 read. */
  ack: number;
};

/** How the bridge runs page scripts: the connector's `run()` and a raw eval. */
export type BridgeHost = {
  run: <T>(script: string, args: Record<string, unknown>) => Promise<T | null>;
  raw: (code: string) => Promise<void>;
  log: (line: string) => void;
};

const LIBRARY = "wppconnect-wa.js";

/** How long a send waits for the server to ack before it is reported unsent. */
export const ACK_WAIT_MS = 20_000;

/** How long attaching waits for the library to find WhatsApp's modules. */
const READY_WAIT_MS = 30_000;
/** How long a chat listing may take before the next sweep asks again; right
 * after a link it waits on history sync. */
export const CHAT_LIST_WAIT_MS = 15_000;

/** App ids (display names and numbers) to WhatsApp ids: a number is a user
 * chat by construction, `@` passes through, a name is looked up in the list. */
export const resolveJid = (
  chatId: string,
  chats: ReadonlyArray<BridgeChat>
): { jid: string } | { error: string } => {
  const trimmed = chatId.trim();
  if (trimmed.length === 0) return { error: "No chat given." };
  if (trimmed.includes("@")) return { jid: trimmed };
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length > 0 && /^\+?[\d\s().-]+$/.test(trimmed))
    return { jid: `${digits}@c.us` };

  const exact = chats.filter((chat) => chat.name === trimmed);
  if (exact.length === 1) return { jid: exact[0]!.jid };
  const lower = trimmed.toLowerCase();
  const loose = chats.filter((chat) => chat.name.toLowerCase() === lower);
  if (loose.length === 1) return { jid: loose[0]!.jid };
  const prefix = chats.filter((chat) =>
    chat.name.toLowerCase().startsWith(lower)
  );
  if (prefix.length === 1) return { jid: prefix[0]!.jid };
  if (exact.length > 1 || loose.length > 1 || prefix.length > 1)
    return {
      error: `More than one WhatsApp chat is called "${trimmed}". Say which one.`,
    };
  return { error: `No WhatsApp chat called "${trimmed}".` };
};

/** The wire-level checks the send makes; exported so a test can pin them. */
export const isServerAck = (ack: number): boolean => ack >= 1;

export class WhatsAppBridge {
  private library: string | null | undefined;
  private attached = false;
  private version: string | null = null;

  constructor(private readonly host: BridgeHost) {}

  /** The page reloaded: whatever was injected is gone. */
  reset(): void {
    this.attached = false;
  }

  get isAttached(): boolean {
    return this.attached;
  }

  /** Inject the library if needed and wait for it to find WhatsApp's modules.
   * False (vendored file missing, or cannot attach) means use the DOM. */
  async ensure(): Promise<boolean> {
    const present = await this.host.run<{ present: boolean; ready: boolean }>(
      PRESENCE_SCRIPT,
      {}
    );
    if (present?.ready === true) {
      this.attached = true;
      return true;
    }

    if (present?.present !== true) {
      const code = this.readLibrary();
      if (code == null) return false;
      try {
        await this.host.raw(code);
      } catch (error) {
        this.host.log(
          `whatsapp-web: bridge could not be injected: ${String((error as Error)?.message ?? error)}`
        );
        this.attached = false;
        return false;
      }
      await this.host.run(INIT_SCRIPT, {});
    }

    const ready = await this.host.run<{ ready: boolean; version: string }>(
      WAIT_READY_SCRIPT,
      { timeoutMs: READY_WAIT_MS }
    );
    if (ready?.ready !== true) {
      if (!this.attached) {
        // Say what IS there, so the failure is diagnosable from the log.
        const probe = await this.host.run<Record<string, unknown>>(
          PROBE_SCRIPT,
          {}
        );
        this.host.log(
          `whatsapp-web: bridge did not attach (WhatsApp's modules were not found); using the page driver ${JSON.stringify(probe)}`
        );
      }
      this.attached = false;
      return false;
    }
    if (!this.attached) {
      this.version = ready.version;
      this.host.log(`whatsapp-web: bridge attached (wa-js ${ready.version})`);
    }
    this.attached = true;
    return true;
  }

  private readLibrary(): string | null {
    if (this.library !== undefined) return this.library;
    try {
      this.library = fs.readFileSync(resourcePath("vendor", LIBRARY), "utf8");
    } catch {
      this.library = null;
      this.host.log(
        `whatsapp-web: vendor/${LIBRARY} is not present (run \`pnpm vendor\`); using the page driver`
      );
    }
    return this.library;
  }

  /** The account this page is signed in as. */
  async myId(): Promise<{ jid: string; digits: string } | null> {
    const result = await this.host.run<{
      jid: string | null;
      digits: string | null;
    }>(MY_ID_SCRIPT, {});
    if (result?.jid == null || result.digits == null) return null;
    return { jid: result.jid, digits: result.digits };
  }

  async listChats(options?: { onlyUnread?: boolean }): Promise<BridgeChat[]> {
    const rows = await this.host.run<BridgeChat[] | null>(LIST_CHATS_SCRIPT, {
      onlyUnread: options?.onlyUnread === true,
      timeoutMs: CHAT_LIST_WAIT_MS,
    });
    if (rows == null)
      this.host.log(
        "whatsapp-web: the chat list did not answer in time (WhatsApp is still syncing); it will be read again"
      );
    return Array.isArray(rows) ? rows : [];
  }

  /** Send and wait for the server ack. A message stuck at ack 0 IS in the
   * outbox and may still go out, so the error carries its id for a recheck. */
  async sendText(jid: string, text: string): Promise<BridgeSendResult> {
    const sent = await this.host.run<{
      ok: boolean;
      id?: string;
      ack?: number;
      error?: string;
    }>(SEND_SCRIPT, { jid, text, ackWaitMs: ACK_WAIT_MS });
    if (sent == null)
      throw new Error(
        "WhatsApp did not answer the send. The page may be reloading."
      );
    if (sent.ok !== true || sent.id == null)
      throw new Error(
        `WhatsApp refused the message: ${sent.error ?? "no reason given"}`
      );
    if (!isServerAck(sent.ack ?? -1))
      throw new QueuedSendError(sent.id, sent.ack ?? -1);
    return { id: sent.id, ack: sent.ack ?? 1 };
  }

  /** The current ack of a message this session sent. */
  async ackOf(messageId: string): Promise<number> {
    const result = await this.host.run<{ ack: number }>(ACK_SCRIPT, {
      messageId,
    });
    return result?.ack ?? -1;
  }

  /** A chat's recent messages, or why not: WhatsApp Web loads chats lazily,
   * and a chat not in the store must not read as an empty chat. */
  async readChat(jid: string, limit: number): Promise<BridgeRead> {
    const result = await this.host.run<BridgeRead>(READ_SCRIPT, {
      jid,
      limit,
    });
    if (result == null)
      return { ok: false, reason: "the page script did not answer" };
    return result.ok === true
      ? { ok: true, rows: Array.isArray(result.rows) ? result.rows : [] }
      : { ok: false, reason: result.reason || "WhatsApp did not say why" };
  }

  /** Whether `jid` is the user's own chat; null if the page did not answer. */
  async isOwnChat(jid: string): Promise<boolean | null> {
    const result = await this.host.run<{ isMe: boolean }>(IS_OWN_CHAT_SCRIPT, {
      jid,
    });
    return result == null ? null : result.isMe === true;
  }

  /** New messages since the last drain, oldest first, plus a logout flag. */
  async drain(): Promise<{ messages: BridgeMessage[]; loggedOut: boolean }> {
    const result = await this.host.run<{
      messages: BridgeMessage[];
      loggedOut: boolean;
    }>(DRAIN_SCRIPT, {});
    return {
      messages: Array.isArray(result?.messages) ? result.messages : [],
      loggedOut: result?.loggedOut === true,
    };
  }

  get libraryVersion(): string | null {
    return this.version;
  }
}

/** A send WhatsApp accepted into the outbox but has not confirmed. */
export class QueuedSendError extends Error {
  constructor(
    readonly messageId: string,
    readonly ack: number
  ) {
    super(
      "WhatsApp queued the message on this device but its server has not accepted it yet: " +
        "the connection may be down. It was NOT resent."
    );
    this.name = "QueuedSendError";
  }
}

// ── Page scripts ─────────────────────────────────────────────────────────
// Each runs inside `(async function(args){ ... })(args)` in the page and
// returns a JSON value. `WPP` is the library's global once injected.

const PRESENCE_SCRIPT = `
  const present = typeof WPP !== "undefined" && WPP != null;
  const ready = present && WPP.isFullReady === true &&
    !!(window.__abacusWa && window.__abacusWa.listening);
  return { present, ready };
`;

/** The mailbox WAIT_READY_SCRIPT fills; the page cannot call into main. */
const INIT_SCRIPT = `
  window.__abacusWa = window.__abacusWa || {
    queue: [], loggedOut: false, listening: false,
  };
  return { ok: true };
`;

/** Wait for the library to find WhatsApp's modules, then hook it. The global
 * carries isFullReady but not webpack.onFullReady, so readiness is polled. */
const WAIT_READY_SCRIPT = `
  const state = window.__abacusWa || (window.__abacusWa = {
    queue: [], loggedOut: false, listening: false,
  });
  const attach = () => {
    if (state.listening) return;
    state.listening = true;
    const push = (msg) => {
      try {
        if (!msg || !msg.id) return;
        // Text only. Media and system events are not something the agent
        // can read here, and reporting "[image]" as a message would hand it
        // a message nobody wrote.
        if (msg.type !== "chat") return;
        const id = msg.id._serialized || String(msg.id);
        const chatId = (msg.id.remote && msg.id.remote._serialized) ||
          (typeof msg.from === "object" ? msg.from._serialized : msg.from) || "";
        const author = msg.author
          ? (typeof msg.author === "object" ? msg.author._serialized : msg.author)
          : null;
        const contact = msg.senderObj || null;
        const senderName = contact
          ? (contact.pushname || contact.name || contact.formattedName || null)
          : null;
        // Whether this is the user's own chat, read from the chat itself, so a
        // fresh link whose chat list is still syncing can tell the user's
        // own words apart from ours without the list.
        let chatIsMe = null;
        try {
          const chat = msg.id.remote && WPP.whatsapp.ChatStore.get(msg.id.remote);
          if (chat && chat.contact) chatIsMe = !!chat.contact.isMe;
        } catch (e) {}
        state.queue.push({
          id, jid: chatId, fromMe: !!msg.id.fromMe,
          senderName: senderName, author: author,
          text: typeof msg.body === "string" ? msg.body : "",
          t: typeof msg.t === "number" ? msg.t : Math.floor(Date.now() / 1000),
          ...(chatIsMe == null ? {} : { chatIsMe }),
        });
        if (state.queue.length > 200) state.queue.splice(0, state.queue.length - 200);
      } catch (e) {}
    };
    WPP.on("chat.new_message", push);
    WPP.on("conn.logout", () => { state.loggedOut = true; });
  };
  const deadline = Date.now() + (args.timeoutMs || 30000);
  while (Date.now() < deadline) {
    if (typeof WPP !== "undefined" && WPP.isFullReady === true) {
      attach();
      return { ready: true, version: String(WPP.version || "unknown") };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ready: false, version: "" };
`;

const MY_ID_SCRIPT = `
  const me = WPP.conn.getMyUserId();
  if (!me) return { jid: null, digits: null };
  const jid = me._serialized || (me.user + "@" + me.server);
  return { jid, digits: String(me.user || "") };
`;

const LIST_CHATS_SCRIPT = `
  const options = { count: 5000 };
  if (args.onlyUnread) options.onlyUnread = true;
  // Bounded: a listing that outlives the wait keeps running in the page,
  // but the caller gets its lock back and asks again later.
  const chats = await Promise.race([
    WPP.chat.list(options),
    new Promise((resolve) => setTimeout(() => resolve(null), args.timeoutMs || 15000)),
  ]);
  if (chats == null) return null;
  let me = null;
  try { me = WPP.conn.getMyUserId(); } catch (e) {}
  const rows = chats.map((chat) => {
    // WhatsApp marks the user's own contact; newer builds also file the
    // own chat under a separate "lid" id, so the user part is compared too.
    let isMe = false;
    try {
      isMe = !!(chat.contact && chat.contact.isMe) ||
        (me != null && chat.id && chat.id.user === me.user);
    } catch (e) {}
    return {
      jid: chat.id._serialized,
      name: chat.formattedTitle || chat.name || (chat.contact && (chat.contact.pushname || chat.contact.name)) || chat.id.user || chat.id._serialized,
      isGroup: !!chat.isGroup,
      isMe,
      unreadCount: Number(chat.unreadCount) || 0,
    };
  });
  // The store's own filter is belt; this is braces, for a build whose
  // list option is ignored.
  return args.onlyUnread ? rows.filter((row) => row.unreadCount !== 0) : rows;
`;

/** Send, then wait for the server ack. The poll after \`waitForAck\` catches
 * an ack that lands a moment late; one that never arrives is not assumed. */
const SEND_SCRIPT = `
  let result;
  try {
    result = await WPP.chat.sendTextMessage(args.jid, args.text, { waitForAck: true });
  } catch (error) {
    return { ok: false, error: String(error && error.message || error) };
  }
  const id = result && result.id;
  if (!id) return { ok: false, error: "no message id returned" };
  const readAck = async () => {
    try {
      const msg = await WPP.chat.getMessageById(id);
      return typeof msg?.ack === "number" ? msg.ack : -1;
    } catch (e) { return -1; }
  };
  let ack = await readAck();
  const deadline = Date.now() + (args.ackWaitMs || 20000);
  while (ack < 1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    ack = await readAck();
  }
  return { ok: true, id, ack };
`;

const ACK_SCRIPT = `
  try {
    const msg = await WPP.chat.getMessageById(args.messageId);
    return { ack: typeof msg?.ack === "number" ? msg.ack : -1 };
  } catch (e) { return { ack: -1 }; }
`;

const READ_SCRIPT = `
  const fetch = (jid) => WPP.chat.getMessages(jid, { count: args.limit || 30 });
  // WhatsApp now files a person's chat under a lid, and the phone-number
  // id the list handed out may not be a key in the store at all. Before
  // giving up, look for the chat whose contact carries that number.
  const byNumber = (jid) => {
    try {
      const wid = WPP.whatsapp.WidFactory.createWid(jid);
      const user = wid.user;
      const chats = WPP.whatsapp.ChatStore.getModelsArray();
      const hit = chats.find((chat) => {
        try {
          if (chat.id && chat.id.user === user) return true;
          const contact = chat.contact;
          if (!contact) return false;
          if (contact.id && contact.id.user === user) return true;
          const pn = contact.phoneNumber;
          return !!(pn && pn.user === user);
        } catch (e) { return false; }
      });
      return hit && hit.id ? hit.id._serialized || String(hit.id) : null;
    } catch (e) { return null; }
  };
  let msgs;
  let jid = args.jid;
  try {
    msgs = await fetch(jid);
  } catch (first) {
    const alias = byNumber(jid);
    if (alias && alias !== jid) jid = alias;
    // Not in the store yet: WhatsApp Web only loads a chat once something
    // opens it. find() pulls it in, and the second ask is the real answer.
    try { await WPP.chat.find(jid); } catch (ignored) {}
    try {
      msgs = await fetch(jid);
    } catch (second) {
      return { ok: false, reason: String((second && second.message) || second) };
    }
  }
  const rows = [];
  for (const msg of msgs) {
    if (!msg || msg.type !== "chat") continue;
    const contact = msg.senderObj || null;
    rows.push({
      id: msg.id._serialized || String(msg.id),
      jid: args.jid,
      fromMe: !!msg.id.fromMe,
      senderName: contact ? (contact.pushname || contact.name || contact.formattedName || null) : null,
      text: typeof msg.body === "string" ? msg.body : "",
      t: typeof msg.t === "number" ? msg.t : 0,
    });
  }
  return { ok: true, rows };
`;

const PROBE_SCRIPT = `
  const out = { type: typeof WPP };
  try {
    if (typeof WPP !== "undefined" && WPP != null) {
      out.keys = Object.keys(WPP).slice(0, 40);
      out.version = WPP.version ?? null;
      out.isReady = WPP.isReady ?? null;
      out.isFullReady = WPP.isFullReady ?? null;
      out.hasWebpack = typeof WPP.webpack;
      out.hasConn = typeof WPP.conn;
    }
    out.chunks = typeof window.webpackChunkwhatsapp_web_client;
    out.state = window.__abacusWa ? { listening: window.__abacusWa.listening } : null;
  } catch (e) { out.error = String(e && e.message || e); }
  return out;
`;

/** Is this chat the user's own? Asked of the chat, the phone id and the lid,
 * so the answer does not wait on a chat list still behind history sync. */
const IS_OWN_CHAT_SCRIPT = `
  const wid = WPP.whatsapp.WidFactory.createWid(args.jid);
  let isMe = false;
  try {
    const chat = WPP.whatsapp.ChatStore.get(wid) || (await WPP.chat.get(wid));
    isMe = !!(chat && chat.contact && chat.contact.isMe);
  } catch (e) {}
  if (!isMe) {
    try { const me = WPP.conn.getMyUserId(); isMe = !!(me && wid.user === me.user); } catch (e) {}
  }
  if (!isMe) {
    try {
      const lid = WPP.whatsapp.UserPrefs.getMaybeMeLidUser();
      isMe = !!(lid && wid.user === lid.user);
    } catch (e) {}
  }
  return { isMe };
`;

const DRAIN_SCRIPT = `
  const state = window.__abacusWa;
  if (!state) return { messages: [], loggedOut: false };
  const messages = state.queue.splice(0, state.queue.length);
  return { messages, loggedOut: state.loggedOut === true };
`;

/** Every page script, for the parse check in tests. */
export const BRIDGE_PAGE_SCRIPTS: Record<string, string> = {
  PRESENCE_SCRIPT,
  INIT_SCRIPT,
  WAIT_READY_SCRIPT,
  MY_ID_SCRIPT,
  LIST_CHATS_SCRIPT,
  SEND_SCRIPT,
  ACK_SCRIPT,
  READ_SCRIPT,
  PROBE_SCRIPT,
  DRAIN_SCRIPT,
  IS_OWN_CHAT_SCRIPT,
};
