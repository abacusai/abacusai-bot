/**
 * Run `task` once the main thread is idle (a short timeout where the
 * browser has no `requestIdleCallback`, as in Safari). Returns a cancel.
 */
export const whenIdle = (task: () => void): (() => void) => {
  if (typeof globalThis.requestIdleCallback === "function") {
    const id = globalThis.requestIdleCallback(task, { timeout: 2_000 });
    return () => globalThis.cancelIdleCallback(id);
  }
  const id = setTimeout(task, 200);
  return () => clearTimeout(id);
};
