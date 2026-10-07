/**
 * Steers handed to pi that have not reached the model yet, oldest first. pi
 * queues text only and delivers it in order, so the oldest entry with the
 * landed text is the one that landed, and its id goes with it.
 */
export interface PendingSteer {
  text: string;
  messageId?: string;
}

export class PendingSteers {
  private readonly entries: PendingSteer[] = [];

  add(text: string, messageId?: string): void {
    this.entries.push(messageId != null ? { text, messageId } : { text });
  }

  clear(): void {
    this.entries.length = 0;
  }

  /** The steer this user message is, now landed; null when it is not one of ours. */
  take(text: string): PendingSteer | null {
    const index = this.entries.findIndex((entry) => entry.text === text);
    if (index === -1) return null;
    return this.entries.splice(index, 1)[0] ?? null;
  }
}
