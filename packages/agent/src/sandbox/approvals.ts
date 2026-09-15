/**
 * Which hidden credential stores the user agreed to let a command read. Owned
 * by the session that showed the card and handed to the shell backend that
 * runs the command, so an approval never crosses sessions.
 */
import { isWithin } from "./secrets.js";

export class CredentialApprovals {
  /** Approved for one run of exactly this command text. */
  private readonly once = new Map<string, string[]>();
  /** Approved for the rest of the session. */
  private readonly session: string[] = [];

  /** Stores the user chose "Always" for. */
  get sessionPaths(): readonly string[] {
    return this.session;
  }

  /** Whether `store` is covered by a session-wide approval. */
  isApprovedForSession(store: string): boolean {
    return this.session.some((allowed) => isWithin(store, allowed));
  }

  approveOnce(command: string, stores: readonly string[]): void {
    if (stores.length === 0) return;
    const merged = new Set([...(this.once.get(command) ?? []), ...stores]);
    this.once.set(command, [...merged]);
  }

  approveForSession(stores: readonly string[]): void {
    for (const store of stores) {
      if (!this.session.includes(store)) this.session.push(store);
    }
  }

  /**
   * Everything the next run of `command` may read: its one-shot grant, taken
   * so it cannot be reused, plus the session-wide stores.
   */
  consume(command: string): string[] {
    const granted = this.once.get(command) ?? [];
    this.once.delete(command);

    return [...new Set([...granted, ...this.session])];
  }
}
