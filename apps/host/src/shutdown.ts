let dispose: (() => Promise<void>) | undefined;
let pending: Promise<void> | undefined;
export const installShutdown = (stop: () => Promise<void>) => {
  dispose = stop;
};
export const shutdown = (code = 0): void => {
  if (pending) return;
  const deadline = setTimeout(() => process.exit(code || 1), 10_000);
  pending = (async () => {
    try {
      await dispose?.();
      process.exitCode = code;
    } catch (error) {
      console.error("[host] shutdown failed", error);
      process.exitCode = code || 1;
    } finally {
      if (code !== 0) {
        clearTimeout(deadline);
        process.exit(code);
      } else deadline.unref();
    }
  })();
};
