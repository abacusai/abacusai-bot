/** Kept off until R6-T30 verifies full-screen Space visibility on physical hardware. */
export const NOTCH_BANNER_SUPPRESSION = false;
export class NotchNotificationPolicy {
  #seen = new Map<string, number>();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  constructor(
    readonly facts: { enabled(): boolean; presented(key: string): boolean },
    readonly suppression = NOTCH_BANNER_SUPPRESSION
  ) {}
  notify(
    input: {
      kind?: "needs-you" | "done" | "failed";
      dedupeKey?: string;
      botReply?: boolean;
    },
    show: () => void
  ): void {
    const now = Date.now();
    for (const [key, at] of this.#seen)
      if (now - at > 600_000) this.#seen.delete(key);
    const key = input.dedupeKey ? `${input.kind}:${input.dedupeKey}` : null;
    if (key && this.#seen.has(key)) return;
    if (key) this.#seen.set(key, now);
    while (this.#seen.size > 1000)
      this.#seen.delete(this.#seen.keys().next().value!);
    if (
      !this.suppression ||
      !this.facts.enabled() ||
      !input.dedupeKey ||
      !(input.kind === "needs-you" || (input.kind === "done" && input.botReply))
    ) {
      show();
      return;
    }
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      if (!this.facts.enabled() || !this.facts.presented(input.dedupeKey!))
        show();
    }, 1500);
    this.#timers.add(timer);
  }
  dispose(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#seen.clear();
  }
}
