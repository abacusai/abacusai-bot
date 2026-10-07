/**
 * A new browser build replaces every hashed file, so a tab still running the
 * old one cannot load a screen it has not opened yet. When the served shell
 * names another entry than the page runs, the page reloads onto it.
 */

/** The hashed entry script a shell or a script list names, if any. */
const entryOf = (text: string): string | undefined =>
  /\/assets\/index-[\w-]+\.js/.exec(text)?.[0];

/**
 * Reloads iff the served shell's entry differs from the running one. Never
 * for the same entry, a failed fetch or a missing entry, so it cannot loop.
 * Resolves whether it reloaded.
 */
export const reloadIfShellChanged = async (
  fetchShell: () => Promise<string>,
  scripts: readonly string[],
  reload: () => void
): Promise<boolean> => {
  const running = entryOf(scripts.join(" "));
  if (running == null) return false;
  let served: string | undefined;
  try {
    served = entryOf(await fetchShell());
  } catch {
    return false;
  }
  if (served == null || served === running) return false;
  reload();
  return true;
};

/**
 * One check in flight at a time: a burst of preload errors checks once, and
 * the page reloads at most once.
 */
export const staleBuildCheck = (
  fetchShell: () => Promise<string>,
  scripts: () => readonly string[],
  reload: () => void
): (() => Promise<void>) => {
  let inFlight: Promise<void> | null = null;
  let reloaded = false;
  return () => {
    if (reloaded) return Promise.resolve();
    inFlight ??= reloadIfShellChanged(fetchShell, scripts(), reload)
      .then((done) => {
        reloaded = done;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
};
