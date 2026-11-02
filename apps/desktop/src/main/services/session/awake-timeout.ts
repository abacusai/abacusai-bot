/** How late a timer may fire before its lateness means the machine slept. */
export const AWAKE_TIMEOUT_SLACK_MS = 5_000;

export interface AwakeTimeout {
  clear(): void;
}

/**
 * A timeout counted in awake time. A timer that came due while the machine
 * slept fires the moment it wakes, before whatever it waits on has had a
 * chance to run; a fire later than its delay plus slack is that, and starts
 * the wait over instead of timing out.
 */
export const setAwakeTimeout = (
  onTimeout: () => void,
  delayMs: number
): AwakeTimeout => {
  let timer: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    const armedAt = Date.now();
    timer = setTimeout(() => {
      if (Date.now() - armedAt > delayMs + AWAKE_TIMEOUT_SLACK_MS) arm();
      else onTimeout();
    }, delayMs);
  };
  arm();
  return { clear: () => clearTimeout(timer) };
};
