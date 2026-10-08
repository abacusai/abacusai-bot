/**
 * Who owns each WhatsApp message the phone lane took in, keyed by its id
 * (the server's message id, or the lane's own for a note). Every state change
 * happens here:
 *
 *   queued  -> handed   given to the session under a handoff id
 *   handed  -> queued   the session definitely refused it
 *   handed  -> closing  its answer (or the apology) is going out
 *   closing -> answered that reached the user; acknowledged
 *   closing -> released it did not: a server message is forgotten for the
 *                       server to redeliver, a host note is queued again
 */

export interface PhoneInboxEntry {
  id: string;
  ts?: number;
  channel?: string;
  sender?: string | null;
  text?: string;
  /**
   * "linked": the user just linked WhatsApp; `sender` is their name there.
   * "note": the host's own news for the loop (a connector connected), never
   * from the server, so never acknowledged.
   */
  kind?: string;
  /** Check-ins the server sent since the user's last message. */
  nudges_sent?: Array<{ at?: number; text?: string }>;
  /** The message is exactly STOP or UNSUBSCRIBE, and nothing was turned off. */
  stop_keyword?: boolean;
}

export type InboundState = "queued" | "handed" | "closing" | "answered";

export interface InboundMessage {
  readonly entry: PhoneInboxEntry;
  /** Arrival order; a requeued message keeps its place. */
  readonly seq: number;
  state: InboundState;
  /** The id the session knows it by while handed: its own, or its batch's. */
  handoff: string | null;
  /** How many times it was handed to the session. */
  handoffs: number;
}

/** Answered messages kept to recognise a redelivery whose ack was lost. */
const ANSWERED_KEPT = 500;

export class PhoneInbox {
  private readonly messages = new Map<string, InboundMessage>();
  private seq = 0;

  get(id: string): InboundMessage | undefined {
    return this.messages.get(id);
  }

  /** A new message, queued; false when the id is already known. */
  add(entry: PhoneInboxEntry): boolean {
    if (this.messages.has(entry.id)) return false;
    this.messages.set(entry.id, {
      entry,
      seq: ++this.seq,
      state: "queued",
      handoff: null,
      handoffs: 0,
    });
    return true;
  }

  /** Queued messages in arrival order. */
  queued(): InboundMessage[] {
    return this.inState("queued");
  }

  handed(): InboundMessage[] {
    return this.inState("handed");
  }

  /** Handed messages the session knows by any of these handoff ids. */
  handedUnder(handoffs: readonly string[]): InboundMessage[] {
    return this.handed().filter(
      (message) => message.handoff != null && handoffs.includes(message.handoff)
    );
  }

  /** queued -> handed, under one handoff id. */
  hand(messages: readonly InboundMessage[], handoff: string): void {
    for (const message of messages) {
      this.expect(message, "queued");
      message.state = "handed";
      message.handoff = handoff;
      message.handoffs += 1;
    }
  }

  /** handed -> closing, at once: nothing else may claim them while their answer goes out. */
  close(messages: readonly InboundMessage[]): InboundMessage[] {
    const claimed = messages.filter((message) => message.state === "handed");
    for (const message of claimed) message.state = "closing";
    return claimed;
  }

  /** Every handed message -> closing: the lane gives up on them. */
  abandon(): InboundMessage[] {
    return this.close(this.handed());
  }

  closing(): InboundMessage[] {
    return this.inState("closing");
  }

  /** handed -> queued: the session definitely did not take it. */
  requeue(messages: readonly InboundMessage[]): void {
    for (const message of messages) {
      this.expect(message, "handed");
      message.state = "queued";
      message.handoff = null;
    }
  }

  /** closing -> answered; queued -> answered when it is given up on before it went. */
  answer(messages: readonly InboundMessage[]): void {
    for (const message of messages) {
      if (message.state !== "closing") this.expect(message, "queued");
      message.state = "answered";
      message.handoff = null;
    }
    this.prune();
  }

  /**
   * closing -> released: its answer never reached the user. The server
   * redelivers its own messages, so those are forgotten unacknowledged; a
   * host note exists only here, so it is queued again.
   */
  release(messages: readonly InboundMessage[]): void {
    for (const message of messages) {
      this.expect(message, "closing");
      if (message.entry.kind === "note") {
        message.state = "queued";
        message.handoff = null;
      } else {
        this.messages.delete(message.entry.id);
      }
    }
  }

  private inState(state: InboundState): InboundMessage[] {
    return [...this.messages.values()]
      .filter((message) => message.state === state)
      .sort((a, b) => a.seq - b.seq);
  }

  private expect(message: InboundMessage, state: InboundState): void {
    if (message.state !== state)
      throw new Error(
        `phone message ${message.entry.id} is ${message.state}, not ${state}`
      );
  }

  private prune(): void {
    const answered = this.inState("answered");
    for (const message of answered.slice(
      0,
      Math.max(0, answered.length - ANSWERED_KEPT)
    ))
      this.messages.delete(message.entry.id);
  }
}
