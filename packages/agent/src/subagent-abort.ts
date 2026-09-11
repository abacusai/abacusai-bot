/**
 * Stop, delivered to a sub-agent run: a sub-session races its completion
 * against this promise the same way it races the wall-clock timeout.
 */

/**
 * Resolves when the signal aborts — immediately if it already has, never if
 * there is no signal. Callers must run `dispose` once the race settles: the
 * signal spans the whole run, so a leftover listener retains its delegation's
 * closure for as long as the run lives.
 */
export function whenAborted(
  signal: AbortSignal | undefined,
  onAbort: () => void
): { aborted: Promise<void>; dispose: () => void } {
  let dispose = (): void => {};

  const aborted = new Promise<void>((resolve) => {
    if (signal == null) return;

    const fire = (): void => {
      onAbort();
      resolve();
    };

    if (signal.aborted) {
      fire();

      return;
    }

    signal.addEventListener("abort", fire, { once: true });
    dispose = (): void => signal.removeEventListener("abort", fire);
  });

  return { aborted, dispose };
}
