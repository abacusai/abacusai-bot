/** Per-document drafts survive route retirement for ten minutes, bounded to 100 threads. */
export class NotchDrafts {
  #entries = new Map<string, { text: string; at: number }>();
  constructor(readonly now: () => number = Date.now) {}
  get(id: string): string | undefined {
    const entry = this.#entries.get(id);
    if (!entry) return;
    if (this.now() - entry.at >= 600_000) {
      this.#entries.delete(id);
      return;
    }
    return entry.text;
  }
  set(id: string, text: string): void {
    this.#entries.delete(id);
    this.#entries.set(id, { text, at: this.now() });
    for (const [key, entry] of this.#entries)
      if (this.now() - entry.at >= 600_000) this.#entries.delete(key);
    while (this.#entries.size > 100)
      this.#entries.delete(this.#entries.keys().next().value!);
  }
  delete(id: string): void {
    this.#entries.delete(id);
  }
}
export const notchDrafts = new NotchDrafts();
