export type CompanionSmoke =
  | "ready"
  | "pending"
  | "n/a"
  | "failed"
  | "disabled: probe failed"
  | "disabled: no internal display"
  | "disabled: no cut-out"
  | "disabled: off by pref";
/** Readiness outcomes, not process liveness, decide a packaged smoke's exit. */
export const runSmoke = async (options: {
  renderer(): Promise<"ready" | "failed" | "timeout">;
  rendererReason?(): string | undefined;
  companion(): CompanionSmoke;
  timeoutMs?: number;
  log(line: string): void;
}): Promise<0 | 1> => {
  const timeoutMs = options.timeoutMs ?? 90_000;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const companion = async (): Promise<CompanionSmoke> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const outcome = options.companion();
      if (outcome !== "pending") return outcome;
      if (Date.now() >= deadline) return "failed";
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, deadline - Date.now()))
      );
    }
  };
  try {
    const [renderer, notch] = await Promise.all([
      Promise.race([options.renderer(), timeout]),
      Promise.race([companion(), timeout.then(() => "failed" as const)]),
    ]);
    options.log(
      `[smoke] renderer ${renderer}${renderer === "failed" ? `: ${options.rendererReason?.() ?? "readiness failure"}` : ""}`
    );
    options.log(`[smoke] notch ${notch}`);
    return renderer === "ready" &&
      (notch === "ready" || notch === "n/a" || notch.startsWith("disabled: "))
      ? 0
      : 1;
  } finally {
    clearTimeout(timer!);
  }
};
