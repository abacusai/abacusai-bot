import { createHash, randomUUID } from "node:crypto";

import {
  parseProgressText,
  PHONE_PROGRESS_TOOL_NAME,
  splitPhoneBubbles,
} from "@abacus-ai/agent/phone-bubbles";
import {
  declaredMedia,
  parseSendMedia,
  type ResolvedMedia,
  SEND_MEDIA_TOOL_NAME,
} from "@abacus-ai/agent/send-media";
import type { AgentEvent, DesktopEvent } from "@abacus-ai/contract/agent-types";
import { isMessageReaction } from "@abacus-ai/contract/message-reactions";

import { backoffDelayMs } from "#main/services/messaging/connector";

import {
  type InboundMessage,
  PhoneInbox,
  type PhoneInboxEntry,
} from "./phone-inbox";
import { PHONE_TURN_LIMITS, TurnClock } from "./turn-clock";

/**
 * The hosted bot's WhatsApp number: a long-poll of the account's phone inbox
 * (`/v1/abacusaibot_channels`, lane "phone") feeding one lifelong phone-loop
 * session. Messages close together go to the session as one; one that
 * arrives while the session works on earlier ones is steered in. Each goes
 * by its id, and the session reports by id which ones each final answer
 * answers (`turn_reply`). PhoneInbox owns every message's state; this class
 * moves messages between the server, the session and the user: text, and
 * media at once or with the final answer: images and documents that
 * `send_media` names or `present_deliverable` hands over. Host-only:
 * the desktop app never builds one.
 */

type ChannelsCall = <T>(
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal
) => Promise<T>;

interface PhoneLaneDeps {
  call: ChannelsCall;
  /** Whether the user's Abacus key is configured; the lane idles without it. */
  hasKey: () => boolean;
  /** The phone loop's session, minted on first use. */
  openSession: () => Promise<{ workspaceId: string; sessionId: string }>;
  /**
   * Ends the session's work and drops what it queued; resolves once it is
   * idle or closed, within its own deadline. A send still on its way is refused.
   */
  stop: (workspaceId: string, sessionId: string) => Promise<void>;
  /** False when the session definitely did not take the message. */
  send: (
    workspaceId: string,
    sessionId: string,
    text: string,
    messageId: string
  ) => Promise<boolean>;
  onAgentEvent: (
    listener: (sessionId: string, payload: DesktopEvent) => void
  ) => () => void;
  /** Keeps the host's idle lease fresh. */
  activity: () => void;
  /** A media id, as bytes, for the session that holds it. */
  resolveMedia: (ref: string, sessionId: string) => ResolvedMedia;
  /** Keeps media held for an answer from eviction, or lets it go. */
  pinMedia?: (ref: string, sessionId: string, pinned: boolean) => void;
  /** Each answered inbox poll, for what it says besides messages (the user's zone). */
  onPolled?: (result: { tz?: unknown }) => void;
  /** Hidden tagged lines that go to the session ahead of an entry. */
  turnNotes?: (entry: PhoneInboxEntry) => string[];
  log?: (line: string) => void;
}

const PHONE_LANE_TIMINGS = {
  ...PHONE_TURN_LIMITS,
  /** Messages this close together go to the session as one. */
  batchMs: 3_000,
  /** WhatsApp's "typing…" lasts about 25 s. */
  typingRefreshMs: 20_000,
  bubblePauseMinMs: 800,
  bubblePauseMaxMs: 1_200,
  /** How often to look for a key while signed out. */
  keyWaitMs: 5_000,
  /** Waits before handing refused messages over again: three tries over about a minute. */
  deliveryRetryMs: [15_000, 45_000],
};

/** The server holds an inbox poll open for at most this long. */
const INBOX_WAIT_SECS = 25;
const CALL_TIMEOUT_MS = 20_000;
/** A reply carrying a document: up to 16 MB goes up in it. */
const DOCUMENT_CALL_TIMEOUT_MS = 90_000;
const PRESENT_TOOL = "present_deliverable";
/** The app's built-in tool server: its tools may arrive under its prefix. */
const BUILTIN_TOOLS_SERVER = "agent-tools";
/** Media ids remembered as sent; each lives 30 minutes, so far fewer are live. */
const MAX_DELIVERED_IDS = 1_000;
const REACT_TOOL = "react_to_message";
/** What the user hears when a turn fails: never silence, never the raw error. */
const FAILURE_REPLY =
  "Sorry, something went wrong on my side. Could you send that again?";

type TurnReply = Extract<AgentEvent, { type: "turn_reply" }>;

/** An image or document for the chat and the words under it. */
interface PhoneMedia {
  ref: string;
  caption: string;
  /** Handed over with `present_deliverable`: the answer itself, never lost in silence. */
  deliverable?: boolean;
}

/** WhatsApp's longest caption; a longer first bubble goes as its own text. */
const MAX_CAPTION_CHARS = 1_024;

/** What the loop is told for one inbox entry, after `notes`, each its own tagged part. */
function phoneTurnText(entry: PhoneInboxEntry, notes: string[] = []): string {
  // The host's own news is one tagged line, so the agent never takes it for
  // the user's words (a consent it checks reads only those).
  if (entry.kind === "note") {
    const line = (entry.text ?? "").replace(/\s+/g, " ").trim();
    return /^\[[a-z][a-z -]*\]/i.test(line) ? line : `[note] ${line}`;
  }
  if (entry.kind !== "linked") return [...notes, entry.text ?? ""].join("\n\n");
  const name = entry.sender?.trim();
  return [
    name
      ? `[linked] The user just connected WhatsApp. Their WhatsApp name: ${name}.`
      : "[linked] The user just connected WhatsApp.",
    ...notes,
  ].join("\n\n");
}

export class PhoneLane {
  private readonly timings: typeof PHONE_LANE_TIMINGS;
  private readonly log: (line: string) => void;
  private readonly inbox = new PhoneInbox();
  private readonly clock: TurnClock;
  private running = false;
  private pollAbort: AbortController | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastArrivalAt = 0;
  private batchTimer: NodeJS.Timeout | null = null;
  private typing: NodeJS.Timeout | null = null;
  private session: { workspaceId: string; sessionId: string } | null = null;
  /** A given-up session being stopped; nothing new goes to it until it is idle or closed. */
  private stopping: Promise<void> | null = null;
  /** Handoffs in a row the session refused; reset by one it takes. */
  private refusals = 0;
  /** This start's first poll asks the server for everything still unanswered. */
  private redeliver = true;
  /** Names this start to the server, so a replaced host's open poll stops taking messages. */
  private poller = randomUUID();
  /** The newest message from the user: a turn of notes alone replies against it. */
  private lastInboundId: string | null = null;
  /** Handoffs reach the session one at a time, in arrival order. */
  private sending: Promise<void> = Promise.resolve();
  /** Everything said to the user goes out in order: progress, answers, apologies. */
  private outbox: Promise<unknown> = Promise.resolve();
  /** Media for the turn's final answer: `send_media` with_answer, and `present_deliverable`'s. */
  private heldMedia: PhoneMedia[] = [];
  /** Handled message ids the server has not taken an ack for yet. */
  private readonly unacked = new Set<string>();
  private ackFailures = 0;
  private ackRetry: NodeJS.Timeout | null = null;
  /** Media ids the server took: each goes to the user once. */
  private readonly deliveredIds = new Set<string>();
  /** Files the session already heard did not go, by content or id. */
  private readonly notedMedia = new Set<string>();
  /** User messages a media note was already raised under. */
  private readonly notedFor = new Set<string>();
  /** This turn's media by content: two captures of the same page go once. */
  private turnMediaHashes = new Set<string>();

  constructor(
    private readonly deps: PhoneLaneDeps,
    timings: Partial<typeof PHONE_LANE_TIMINGS> = {}
  ) {
    this.timings = { ...PHONE_LANE_TIMINGS, ...timings };
    this.log = deps.log ?? ((line) => console.log(line));
    this.clock = new TurnClock(this.timings, (reason) => {
      void this.giveUp(`timeout-${reason}`);
    });
  }

  /** The session holds messages, their answers are going out, or it is being stopped. */
  get busy(): boolean {
    return (
      this.inbox.handed().length > 0 ||
      this.inbox.closing().length > 0 ||
      this.stopping != null
    );
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.redeliver = true;
    this.poller = randomUUID();
    this.unsubscribe = this.deps.onAgentEvent((sessionId, payload) =>
      this.onAgentEvent(sessionId, payload)
    );
    void this.pollLoop();
  }

  stop(): void {
    this.running = false;
    this.pollAbort?.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.batchTimer != null) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    if (this.ackRetry != null) clearTimeout(this.ackRetry);
    this.ackRetry = null;
    this.idle();
  }

  private async pollLoop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      if (!this.deps.hasKey()) {
        await sleep(this.timings.keyWaitMs);
        continue;
      }
      // Acks still owed go first, so a handled message is not handed back.
      if (this.unacked.size > 0) await this.acknowledge([]);
      const abort = new AbortController();
      this.pollAbort = abort;
      try {
        const result = await this.deps.call<{
          messages?: PhoneInboxEntry[];
          tz?: unknown;
        }>(
          {
            action: "inbox",
            wait: INBOX_WAIT_SECS,
            lane: "phone",
            poller: this.poller,
            ...(this.redeliver ? { redeliver: true } : {}),
          },
          (INBOX_WAIT_SECS + 15) * 1000,
          abort.signal
        );
        failures = 0;
        this.redeliver = false;
        this.deps.onPolled?.(result);
        for (const entry of result.messages ?? []) this.arrive(entry);
      } catch (error) {
        if (!this.running) return;
        failures += 1;
        this.log(
          `[phone] inbox poll failed (attempt ${failures}): ${describe(error)}`
        );
        await sleep(backoffDelayMs(failures));
      } finally {
        if (this.pollAbort === abort) this.pollAbort = null;
      }
    }
  }

  /**
   * One inbox entry, with "typing…" shown now: steered in while the session
   * works on earlier messages, else queued for the next handoff.
   */
  arrive(entry: PhoneInboxEntry): void {
    if (typeof entry.id !== "string") return;
    const known = this.inbox.get(entry.id);
    if (known != null) {
      // Back from the server: handled, but the ack was lost (or is on its way).
      if (known.state === "handled") void this.ack([known]);
      return;
    }
    if (entry.kind !== "linked" && !entry.text?.trim()) {
      void this.acknowledge([entry.id]);
      return;
    }
    this.inbox.add(entry);
    this.lastInboundId = entry.id;
    this.lastArrivalAt = Date.now();
    void this.channel("typing", { message_id: entry.id });
    const message = this.inbox.get(entry.id)!;
    if (this.canSteer(message)) this.steer(message);
    else if (!this.busy) this.armBatch();
  }

  /**
   * The host's news for the loop (a connector the user just connected): a
   * handoff of its own, so the user hears it without asking. It answers
   * against the user's newest message, so with none this start, it waits.
   */
  note(text: string): void {
    this.inbox.add({ id: `note-${randomUUID()}`, kind: "note", text });
    this.lastArrivalAt = Date.now();
    if (!this.busy && this.lastInboundId != null) this.armBatch();
  }

  /**
   * The session is working on handed messages under a running clock, and
   * nothing queued is ahead of the message, so order holds.
   */
  private canSteer(message: InboundMessage): boolean {
    return (
      this.clock.running &&
      this.inbox.handed().length > 0 &&
      this.session != null &&
      this.inbox
        .queued()
        .every((queued) => queued === message || queued.entry.kind === "note")
    );
  }

  /** Into the session's work under the message's own id. */
  private steer(message: InboundMessage): void {
    this.inbox.hand([message], message.entry.id);
    this.clock.touch();
    void this.handOff([message], message.entry.id);
  }

  /** Hand everything queued to the session once no message arrived for the batch window. */
  private armBatch(delayMs?: number): void {
    if (this.batchTimer != null) clearTimeout(this.batchTimer);
    const wait =
      delayMs ??
      Math.max(0, this.lastArrivalAt + this.timings.batchMs - Date.now());
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      this.startBatch();
    }, wait);
    this.batchTimer.unref?.();
  }

  private startBatch(): void {
    if (!this.running || this.busy) return;
    const batch = this.inbox.queued();
    if (batch.length === 0) return;
    // Notes alone answer against the user's newest message; none yet, they wait.
    if (this.replyTarget(batch) == null) return;
    const handoff = (
      batch.findLast((message) => message.entry.kind !== "note") ??
      batch.at(-1)!
    ).entry.id;
    this.inbox.hand(batch, handoff);
    this.working();
    this.log(
      `[phone] handoff messages=${batch.length} linked=${batch.filter((message) => message.entry.kind === "linked").length}`
    );
    void this.handOff(
      batch,
      handoff,
      batch.map((message) => this.turnText(message.entry)).join("\n\n")
    );
  }

  /** One send to the session, after those before it; a refusal requeues the messages. */
  private handOff(
    messages: InboundMessage[],
    handoff: string,
    text = this.turnText(messages[0]!.entry)
  ): Promise<void> {
    const run = this.sending.then(async () => {
      if (await this.trySend(text, handoff)) {
        for (const message of messages) message.taken = true;
        this.refusals = 0;
        this.deps.activity();
        return;
      }
      // An expiry may have settled some while the send was out.
      const refused = messages.filter((message) => message.state === "handed");
      this.inbox.requeue(refused);
      this.refusals += 1;
      this.log(
        `[phone] session refused handoff (refusal ${this.refusals}); queued again`
      );
      this.settle();
    });
    this.sending = run.catch((error: unknown) =>
      this.log(`[phone] handoff failed: ${describe(error)}`)
    );
    return run;
  }

  private turnText(entry: PhoneInboxEntry): string {
    return phoneTurnText(entry, this.deps.turnNotes?.(entry) ?? []);
  }

  private async trySend(text: string, handoff: string): Promise<boolean> {
    try {
      this.session ??= await this.deps.openSession();
      const { workspaceId, sessionId } = this.session;
      return await this.deps.send(workspaceId, sessionId, text, handoff);
    } catch (error) {
      this.log(`[phone] send failed: ${describe(error)}`);
      return false;
    }
  }

  private onAgentEvent(sessionId: string, payload: DesktopEvent): void {
    if (
      this.session?.sessionId !== sessionId ||
      payload.type !== "event" ||
      !this.busy
    )
      return;
    const event = payload.event;
    switch (event.type) {
      case "turn_reply":
        void this.finish(event);
        return;
      case "user_message_steered":
      case "user_message_dequeued":
        if (event.messageId != null)
          this.log(`[phone] ${event.type} id=${event.messageId}`);
        this.clock.touch();
        return;
      case "text_delta":
      case "thinking_delta":
      case "tool_execution_start":
      case "tool_output_update":
      case "subtask_start":
      case "subtask_end":
        this.clock.touch();
        return;
      case "tool_execution_complete":
        this.clock.touch();
        this.onToolDone(event);
        return;
      default:
        return;
    }
  }

  /**
   * A finished tool call that speaks to the chat. Only a call the tool
   * accepted goes out: an error result is skipped, and the input is read
   * through the tool's own check, so a refused call never sends (and the
   * model's corrected retry is not a duplicate).
   */
  private onToolDone(
    event: Extract<AgentEvent, { type: "tool_execution_complete" }>
  ): void {
    if (event.result.rejected === true) return;
    const replyTo = this.replyTarget(this.inbox.handed());
    if (replyTo == null) return;
    if (isTool(event.tool.name, REACT_TOOL)) {
      const emoji = event.tool.input.emoji;
      if (isMessageReaction(emoji))
        void this.channel("react", { message_id: replyTo, emoji });
      return;
    }
    // What present_deliverable accepted goes with the answer, as its media.
    if (isTool(event.tool.name, PRESENT_TOOL)) {
      for (const ref of declaredMedia(event.result.content))
        this.hold({ ref, caption: "", deliverable: true });
      return;
    }
    // A progress line or media goes out now; neither answers the message.
    let sent: Promise<boolean> | null = null;
    if (isTool(event.tool.name, PHONE_PROGRESS_TOOL_NAME)) {
      const progress = parseProgressText(event.tool.input);
      if (progress.ok === false) return;
      sent = this.sendInOrder(replyTo, [progress.text]).then((n) => n > 0);
    } else if (isTool(event.tool.name, SEND_MEDIA_TOOL_NAME)) {
      const parsed = parseSendMedia(event.tool.input);
      if (parsed.ok === false) return;
      const { media, caption, when } = parsed.request;
      const item = { ref: media, caption };
      if (when === "with_answer") {
        this.hold(item);
        return;
      }
      sent = this.sendMedia(replyTo, item).then((went) => went.image);
    }
    if (sent == null) return;
    this.deps.activity();
    void sent.then((went) => {
      // A sent message clears WhatsApp's "typing…"; the session is still working.
      if (went && this.busy)
        void this.channel("typing", { message_id: replyTo });
    });
  }

  /** Media for the answer, kept from eviction until the turn ends. */
  private hold(media: PhoneMedia): void {
    this.heldMedia.push(media);
    const sessionId = this.session?.sessionId;
    if (sessionId != null) this.deps.pinMedia?.(media.ref, sessionId, true);
  }

  /** The turn is over: what it held may be evicted again. */
  private release(held: PhoneMedia[]): void {
    const sessionId = this.session?.sessionId;
    if (sessionId == null) return;
    for (const media of held) this.deps.pinMedia?.(media.ref, sessionId, false);
  }

  /**
   * An image or document with its caption, after whatever is already on its
   * way. Each media id goes once, and the same bytes once a turn, counted
   * only once the server took them: a resend of what already went is
   * skipped, and its caption still goes as text. One the server refuses (or
   * that cannot be read) also leaves its caption as text; for a file handed
   * over, the session hears it did not go (see `noteNotAttached`). A
   * document the server did not answer in time may still have gone: the
   * session hears that it is unconfirmed and the caption is not repeated.
   * `words` says whether the caption reached the chat.
   */
  private sendMedia(
    replyTo: string,
    media: PhoneMedia
  ): Promise<{ image: boolean; words: boolean }> {
    const run = this.outbox.then(async () => {
      if (!this.running) return { image: false, words: false };
      // The phone session's own media only; its browser runs share its id.
      const sessionId = this.session?.sessionId;
      const resolved: ResolvedMedia =
        sessionId == null
          ? { ok: false, reason: "no session" }
          : this.deps.resolveMedia(media.ref, sessionId);
      const hash =
        resolved.ok === true
          ? createHash("sha256").update(resolved.data).digest("hex")
          : null;
      const duplicate =
        this.deliveredIds.has(media.ref) ||
        (hash != null && this.turnMediaHashes.has(hash));
      let outcome: "sent" | "refused" | "unknown" = "refused";
      if (resolved.ok === false)
        this.log(`[phone] media not sent: ${resolved.reason}`);
      else if (duplicate)
        this.log(`[phone] media ${media.ref} already went; not again`);
      else
        outcome = await this.replyWithMedia(
          {
            message_id: replyTo,
            ...(resolved.kind === "image"
              ? { image_b64: resolved.data.toString("base64") }
              : {
                  document_b64: resolved.data.toString("base64"),
                  filename: resolved.filename,
                }),
            ...(media.caption.length > 0 ? { text: media.caption } : {}),
          },
          resolved.kind === "document"
        );
      if (outcome === "sent") {
        this.markDelivered(media.ref);
        if (hash != null) this.turnMediaHashes.add(hash);
        return { image: true, words: true };
      }
      const named =
        resolved.ok === true && resolved.kind === "document"
          ? `The file ${resolved.filename}`
          : media.deliverable === true
            ? "An image you handed over"
            : null;
      if (outcome === "unknown") {
        // It may well have gone, caption and all: nothing is repeated.
        this.log(`[phone] media ${media.ref} delivery unknown`);
        if (named != null)
          this.noteOnce(media.ref, replyTo, unconfirmedNote(named));
        return { image: false, words: true };
      }
      if (!duplicate && named != null)
        this.noteOnce(hash ?? media.ref, replyTo, notAttachedNote(named));
      const words =
        media.caption.length === 0 ||
        (await this.channel("reply", {
          message_id: replyTo,
          text: media.caption,
        }));
      return { image: false, words };
    });
    this.outbox = run.catch(() => ({ image: false, words: false }));
    return run;
  }

  /**
   * A reply carrying media: sent, refused, or (a document with no answer in
   * time) unknown. An image's timeout counts as refused, as it always has.
   */
  private async replyWithMedia(
    body: Record<string, unknown>,
    document: boolean
  ): Promise<"sent" | "refused" | "unknown"> {
    try {
      const result = await this.deps.call<{ ok?: boolean; error?: string }>(
        { action: "reply", ...body },
        document ? DOCUMENT_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS
      );
      if (result.ok === true) return "sent";
      this.log(`[phone] reply refused: ${result.error ?? "no reason"}`);
      return "refused";
    } catch (error) {
      if (document && error instanceof Error && error.name === "TimeoutError")
        return "unknown";
      this.log(`[phone] reply failed: ${describe(error)}`);
      return "refused";
    }
  }

  private markDelivered(ref: string): void {
    this.deliveredIds.add(ref);
    // Ids outlive their media by far past this; the oldest go first.
    if (this.deliveredIds.size > MAX_DELIVERED_IDS)
      this.deliveredIds.delete(this.deliveredIds.values().next().value!);
  }

  /**
   * A note to the session about media that did not go: at most one per file
   * (by content, else id) in the conversation, and one per user message, so
   * a model that keeps retrying cannot keep a loop of notes going.
   */
  private noteOnce(key: string, replyTo: string, text: string): void {
    if (this.notedMedia.has(key) || this.notedFor.has(replyTo)) return;
    this.notedMedia.add(key);
    this.notedFor.add(replyTo);
    if (this.notedMedia.size > MAX_DELIVERED_IDS)
      this.notedMedia.delete(this.notedMedia.values().next().value!);
    if (this.notedFor.size > MAX_DELIVERED_IDS)
      this.notedFor.delete(this.notedFor.values().next().value!);
    this.note(text);
  }

  /**
   * The answer's bubbles after the media held for it. The first image with
   * no caption of its own carries the first bubble as its caption.
   */
  private async deliverWithMedia(
    replyTo: string,
    bubbles: string[],
    media: PhoneMedia[]
  ): Promise<boolean> {
    let rest = bubbles;
    for (const [index, item] of media.entries()) {
      const first = rest[0];
      const rides =
        index === 0 &&
        item.caption.length === 0 &&
        first != null &&
        first.length <= MAX_CAPTION_CHARS;
      const went = await this.sendMedia(
        replyTo,
        rides ? { ...item, caption: first } : item
      );
      if (rides && went.words) rest = rest.slice(1);
    }
    return rest.length === 0 || (await this.deliverAnswer(replyTo, rest));
  }

  /**
   * The session's final answer to the messages it names. Its turn ended, so
   * they are handled and acknowledged now, whether or not the reply reaches
   * the user: a reply that does not go is retried as a send, then logged and
   * dropped, never run again. Only a host that dies mid-turn leaves them
   * unacknowledged, for the server to hand back.
   */
  private async finish(reply: TurnReply): Promise<void> {
    const messages = this.inbox.close(this.inbox.handedUnder(reply.messageIds));
    if (messages.length === 0) return;
    this.clock.touch();
    const acked = this.ack(messages);
    const replyTo = this.replyTarget(messages)!;
    const bubbles = splitPhoneBubbles(reply.text);
    // A failed turn's media is not an answer; it goes with nothing.
    const media = this.heldMedia.splice(0);
    let delivered: boolean;
    try {
      delivered =
        media.length > 0 && !reply.failed
          ? await this.deliverWithMedia(replyTo, bubbles, media)
          : await this.deliverAnswer(replyTo, bubbles);
    } finally {
      // Pinned until it went (or was dropped), never before.
      this.release(media);
    }
    const apologized = reply.failed && (await this.apologize(replyTo));
    const went = reply.failed ? apologized : bubbles.length === 0 || delivered;
    this.log(
      `[phone] reply ids=${reply.messageIds.join(",")} bubbles=${bubbles.length} media=${media.length} delivered=${delivered ? 1 : 0} failed=${reply.failed ? 1 : 0} apology=${apologized ? 1 : 0}${went ? "" : " dropped=1"}`
    );
    this.turnMediaHashes = new Set();
    await acked;
    this.done(messages);
  }

  /** Every bubble out, with one more try for what did not go; true when all went. */
  private async deliverAnswer(
    replyTo: string,
    bubbles: string[]
  ): Promise<boolean> {
    if (bubbles.length === 0) return false;
    const sent = await this.sendInOrder(replyTo, bubbles);
    if (sent === bubbles.length) return true;
    const retried = await this.sendInOrder(replyTo, bubbles.slice(sent));
    return sent + retried === bubbles.length;
  }

  /**
   * The session's work ran out of time. Everything it holds is claimed at
   * once, the session is stopped (its queue with it), and the user hears the
   * apology; nothing new goes to the session until it is idle or closed.
   * What the session took is acknowledged (it may have acted on it, so it
   * is never run again); what it never took goes again.
   */
  private async giveUp(reason: string): Promise<void> {
    const messages = this.inbox.abandon();
    if (messages.length === 0) return;
    this.clock.stop();
    this.release(this.heldMedia.splice(0));
    this.turnMediaHashes = new Set();
    // The session refuses a handoff still on its way; the stop is bounded by its owner.
    this.stopping = this.stopSession();
    const apologized = await this.apologize(this.replyTarget(messages)!);
    this.log(
      `[phone] gave up outcome=${reason} messages=${messages.length} apology=${apologized ? 1 : 0}`
    );
    await this.stopping;
    // A handoff still on its way settles (refused) before it is judged.
    await this.sending;
    this.stopping = null;
    const taken = messages.filter((message) => message.taken);
    // One the session never took was never run: it goes to the next turn.
    this.inbox.putBack(messages.filter((message) => !message.taken));
    await this.ack(taken);
    this.done(taken);
  }

  private async stopSession(): Promise<void> {
    if (this.session == null) return;
    const { workspaceId, sessionId } = this.session;
    try {
      await this.deps.stop(workspaceId, sessionId);
    } catch (error) {
      this.log(`[phone] stop failed: ${describe(error)}`);
    }
  }

  /** Closing messages, acknowledged: handled, and the lane free for what waits. */
  private done(messages: InboundMessage[]): void {
    this.inbox.handle(messages);
    this.deps.activity();
    this.settle();
  }

  /**
   * Nothing held any more: stop the clocks, and hand over what waited. A
   * note the session refused waits to ride along with the user's next message.
   */
  private settle(): void {
    if (this.busy) return;
    this.idle();
    const queued = this.inbox.queued();
    if (queued.length === 0) return;
    const retries = this.timings.deliveryRetryMs;
    if (this.refusals > retries.length) void this.undeliverable(queued);
    else if (this.refusals > 0) this.armBatch(retries[this.refusals - 1]);
    else if (
      queued.some(
        (message) => message.entry.kind !== "note" || message.handoffs === 0
      )
    )
      this.armBatch();
  }

  /** The session refused every try: the user hears it once, and the messages are done. */
  private async undeliverable(messages: InboundMessage[]): Promise<void> {
    this.refusals = 0;
    const replyTo = this.replyTarget(messages);
    const apologized = replyTo != null && (await this.apologize(replyTo));
    this.log(
      `[phone] undeliverable messages=${messages.length} apology=${apologized ? 1 : 0}`
    );
    if (!apologized) return;
    const waiting = messages.filter((message) => message.state === "queued");
    this.inbox.handle(waiting);
    await this.ack(waiting);
  }

  private async apologize(replyTo: string): Promise<boolean> {
    if (!this.running) return false;
    return (await this.sendInOrder(replyTo, [FAILURE_REPLY])) === 1;
  }

  /** The session took work: the clock runs and the user sees "typing…". */
  private working(): void {
    this.clock.start();
    this.deps.activity();
    if (this.typing != null) return;
    this.typing = setInterval(() => {
      const replyTo = this.replyTarget(this.inbox.handed());
      if (replyTo != null) void this.channel("typing", { message_id: replyTo });
    }, this.timings.typingRefreshMs);
    this.typing.unref?.();
  }

  private idle(): void {
    this.clock.stop();
    if (this.typing != null) clearInterval(this.typing);
    this.typing = null;
  }

  /** The newest of these from the user, else the user's newest message. */
  private replyTarget(messages: readonly InboundMessage[]): string | null {
    return (
      messages.findLast((message) => message.entry.kind !== "note")?.entry.id ??
      this.lastInboundId
    );
  }

  /** Bubbles to the user after whatever is already on its way; resolves with how many went. */
  private sendInOrder(replyTo: string, bubbles: string[]): Promise<number> {
    const run = this.outbox.then(() => this.sendBubbles(replyTo, bubbles));
    this.outbox = run.catch(() => 0);
    return run;
  }

  private async sendBubbles(
    replyTo: string,
    bubbles: string[]
  ): Promise<number> {
    let sent = 0;
    for (const bubble of bubbles) {
      if (!this.running) break;
      if (sent > 0) {
        void this.channel("typing", { message_id: replyTo });
        await sleep(
          this.timings.bubblePauseMinMs +
            Math.random() *
              (this.timings.bubblePauseMaxMs - this.timings.bubblePauseMinMs)
        );
      }
      if (!(await this.channel("reply", { message_id: replyTo, text: bubble })))
        break;
      sent += 1;
    }
    return sent;
  }

  /** The server's messages among these; the host's own notes have nothing to acknowledge. */
  private async ack(messages: readonly InboundMessage[]): Promise<void> {
    if (!this.running) return;
    await this.acknowledge(
      messages
        .filter((message) => message.entry.kind !== "note")
        .map((message) => message.entry.id)
    );
  }

  /**
   * Acknowledges `ids`. One that fails stays owed and goes again, with
   * backoff and on every inbox poll, until the server takes it: an ack
   * that never lands would have the message run again.
   */
  private async acknowledge(ids: string[]): Promise<void> {
    for (const id of ids) this.unacked.add(id);
    const owed = [...this.unacked];
    if (owed.length === 0) return;
    try {
      await this.deps.call(
        { action: "ack", message_ids: owed },
        CALL_TIMEOUT_MS
      );
      for (const id of owed) this.unacked.delete(id);
      this.ackFailures = 0;
      if (this.ackRetry != null) clearTimeout(this.ackRetry);
      this.ackRetry = null;
    } catch (error) {
      this.ackFailures += 1;
      this.log(
        `[phone] ack failed (attempt ${this.ackFailures}): ${describe(error)}`
      );
      if (this.ackRetry == null && this.running) {
        this.ackRetry = setTimeout(() => {
          this.ackRetry = null;
          void this.acknowledge([]);
        }, backoffDelayMs(this.ackFailures));
        this.ackRetry.unref?.();
      }
    }
  }

  /** One fire-and-report channel call; true when the server took it. */
  private async channel(
    action: "typing" | "reply" | "react",
    body: Record<string, unknown>,
    timeoutMs = CALL_TIMEOUT_MS
  ): Promise<boolean> {
    try {
      const result = await this.deps.call<{ ok?: boolean; error?: string }>(
        { action, ...body },
        timeoutMs
      );
      if (action === "typing" || result.ok === true) return true;
      this.log(`[phone] ${action} refused: ${result.error ?? "no reason"}`);
    } catch (error) {
      this.log(`[phone] ${action} failed: ${describe(error)}`);
    }
    return false;
  }
}

/** `/v1/abacusaibot_channels` with the user's Abacus key. */
export function channelsTransport(options: {
  baseUrl: () => string;
  key: () => string | null;
  userAgent: () => string;
}): ChannelsCall {
  return async <T>(
    body: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<T> => {
    const key = options.key();
    if (key == null) throw new Error("Abacus.AI is not connected.");
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`${options.baseUrl()}/abacusaibot_channels`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "user-agent": options.userAgent(),
      },
      body: JSON.stringify(body),
      signal: signal != null ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const payload = (await response.json().catch(() => ({}))) as T & {
      error?: string;
    };
    if (!response.ok)
      throw new Error(
        payload.error ?? `Abacus API returned ${response.status}`
      );
    return payload;
  };
}

/**
 * What the session hears when a file did not reach the chat: a turn of its
 * own, so the user is told in their language rather than left waiting.
 */
function notAttachedNote(what: string): string {
  return (
    `[not attached] ${what} could not be attached in WhatsApp. Tell the user ` +
    "in one short text, in their language, that it did not come through, and give them " +
    "its content another way if you can (a short summary, or a `page` link). Do not " +
    "send it again."
  );
}

/** When WhatsApp did not say in time whether a file went. */
function unconfirmedNote(what: string): string {
  return (
    `[delivery unconfirmed] ${what} was sent to WhatsApp, which did not confirm it in ` +
    "time; it has most likely arrived. Do not tell the user it failed, and do not send it " +
    "again unless they say it did not arrive. Reply with exactly NO_REPLY."
  );
}

/** The tool by its own name, or as the app's built-in tool server names it. */
const isTool = (name: string, tool: string): boolean =>
  name === tool || name === `${BUILTIN_TOOLS_SERVER}_${tool}`;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
