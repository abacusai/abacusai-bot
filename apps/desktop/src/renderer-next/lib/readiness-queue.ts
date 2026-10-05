/** Buffer notices while their owning collection snapshots load. Failed preloads retry. */
export const createReadinessQueue = (
  preload: () => Promise<unknown>,
  signal: AbortSignal,
  retryMs = 1000
) => {
  let ready = false;
  const pending: Array<() => void> = [];
  const drain = async () => {
    while (!signal.aborted) {
      try {
        await preload();
        if (signal.aborted) return;
        ready = true;
        for (const run of pending.splice(0)) run();
        return;
      } catch {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, retryMs);
          function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          }
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
    }
  };
  const loaded = drain();
  return {
    loaded,
    run(callback: () => void) {
      if (signal.aborted) return;
      if (ready) callback();
      else pending.push(callback);
    },
  };
};
