/**
 * Who owns each WhatsApp message the phone lane took in, keyed by its id
 * (the server's message id, or the lane's own for a note). A message moves
 * queued -> handed (given to the session under a handoff id) -> answered (its
 * final answer delivered), or from handed back to queued only when the
 * session definitely refused it. Every state change happens here.
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
}

export type InboundState = "queued" | "handed" | "answered";

export interface InboundMessage {
  readonly entry: PhoneInboxEntry;
  /** Arrival order; a requeued message keeps its place. */
  readonly seq: number;
  state: InboundState;
  /** The id the session knows it by while handed: its own, or its batch's. */
  handoff: string | null;
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
    }
  }

  /** handed -> queued: the session definitely did not take it. */
  requeue(messages: readonly InboundMessage[]): void {
    for (const message of messages) {
      this.expect(message, "handed");
      message.state = "queued";
      message.handoff = null;
    }
  }

  /** queued | handed -> answered. */
  answer(messages: readonly InboundMessage[]): void {
    for (const message of messages) {
      if (message.state === "answered") continue;
      message.state = "answered";
      message.handoff = null;
    }
    this.prune();
  }

  /**
   * Handed, but its answer never reached the user: forgotten unacknowledged,
   * so the server's redelivery reads as a new message.
   */
  release(messages: readonly InboundMessage[]): void {
    for (const message of messages) {
      this.expect(message, "handed");
      this.messages.delete(message.entry.id);
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
