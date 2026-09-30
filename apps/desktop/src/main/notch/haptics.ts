import { execFile, type ChildProcess } from "node:child_process";
// AppKit's alignment feedback pattern and immediate performance time.
export const HAPTIC_JXA =
  "ObjC.import('AppKit'); $.NSHapticFeedbackManager.defaultPerformer.performFeedbackPatternPerformanceTime(0, 0);";
export class Haptics {
  readonly #keys = new Map<string, number>();
  readonly #children = new Set<ChildProcess>();
  #logged = false;
  play(key: string, enabled: boolean, platform: string): void {
    if (!enabled || platform !== "darwin") return;
    const now = Date.now();
    for (const [k, at] of this.#keys)
      if (now - at > 600_000) this.#keys.delete(k);
    if (this.#keys.has(key)) return;
    this.#keys.set(key, now);
    while (this.#keys.size > 500)
      this.#keys.delete(this.#keys.keys().next().value!);
    const child = execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", HAPTIC_JXA],
      { timeout: 2000 },
      (error) => {
        this.#children.delete(child);
        if (error && !this.#logged) {
          this.#logged = true;
          console.warn("[notch] haptic failed", error);
        }
      }
    );
    this.#children.add(child);
  }
  dispose(): void {
    for (const child of this.#children) child.kill();
    this.#children.clear();
  }
}
