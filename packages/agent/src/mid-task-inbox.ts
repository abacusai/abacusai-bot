/**
 * The one route for a message the user sends while a browser run works.
 * While a run is open it alone takes them; the engine routes to the main
 * session only when none is. A message the run's model reads is reported
 * once, by id; one it never reads stays in the host's queue, which runs it
 * as its own turn.
 */

/** A message from the user mid-turn, with the sender's id. */
export interface MidTaskMessage {
  text: string;
  messageId?: string;
}

/** How a mid-task message reads inside the run. */
export const midTaskText = (text: string): string => `[user mid-task] ${text}`;

/** One open run's view of the inbox. */
export class MidTaskRun {
  /** Handed to the run's session, not yet read by its model; oldest first. */
  private readonly unread: MidTaskMessage[] = [];
  private readonly consumed: string[] = [];
  private closed = false;

  constructor(
    private readonly steer: (text: string) => Promise<void>,
    private readonly onConsumed: (message: MidTaskMessage) => void
  ) {}

  /** Into the run's session; rejects, untracked, when the session refused it. */
  async deliver(message: MidTaskMessage): Promise<void> {
    this.unread.push(message);
    try {
      await this.steer(midTaskText(message.text));
    } catch (error) {
      this.unread.splice(this.unread.indexOf(message), 1);
      throw error;
    }
  }

  /** A user message started in the run's session: the oldest match is the one read. */
  noteUserMessage(text: string): void {
    if (this.closed) return;
    const index = this.unread.findIndex(
      (message) => midTaskText(message.text) === text
    );
    if (index === -1) return;
    const [message] = this.unread.splice(index, 1);
    if (message == null) return;
    if (message.messageId != null) this.consumed.push(message.messageId);
    this.onConsumed(message);
  }

  /** The run is over: what its model never read stays the host's to run. */
  finish(): void {
    this.closed = true;
    this.unread.length = 0;
  }

  /** The ids the run's model read, in order. */
  consumedIds(): string[] {
    return [...this.consumed];
  }
}

export class MidTaskInbox {
  private run: MidTaskRun | null = null;

  constructor(private readonly onConsumed: (message: MidTaskMessage) => void) {}

  get live(): boolean {
    return this.run != null;
  }

  /** A run starts taking messages; null when another run already does. */
  open(steer: (text: string) => Promise<void>): MidTaskRun | null {
    if (this.run != null) return null;
    this.run = new MidTaskRun(steer, this.onConsumed);
    return this.run;
  }

  close(run: MidTaskRun): void {
    run.finish();
    if (this.run === run) this.run = null;
  }

  async deliver(message: MidTaskMessage): Promise<void> {
    if (this.run == null) throw new Error("No browser run is taking messages.");
    await this.run.deliver(message);
  }
}
