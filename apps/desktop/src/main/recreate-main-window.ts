interface RecreationDependencies<State> {
  capture(): State | null;
  destroy(): void;
  create(state: State): Promise<void>;
  quit(): void;
  platform: string;
}

/** Keep window-all-closed from quitting while the replacement is loading. */
export function mainWindowLifecycle<State>(
  dependencies: RecreationDependencies<State>
) {
  let recreatingMainWindow = false;
  return {
    get recreatingMainWindow() {
      return recreatingMainWindow;
    },
    async recreateMainWindow(): Promise<void> {
      if (recreatingMainWindow) return;
      const state = dependencies.capture();
      if (state === null) return;
      recreatingMainWindow = true;
      try {
        dependencies.destroy();
        await dependencies.create(state);
      } finally {
        recreatingMainWindow = false;
      }
    },
    onWindowAllClosed(): void {
      if (!recreatingMainWindow && dependencies.platform !== "darwin") {
        dependencies.quit();
      }
    },
  };
}

/**
 * What closing the main window does. macOS always hides (Dock convention).
 * Windows and Linux hide to the tray during first run, where an early close
 * was almost always a user who meant to come back, and otherwise ask only
 * when a task would be stopped. A real quit always closes.
 */
export function mainWindowCloseAction(state: {
  platform: string;
  quitting: boolean;
  firstRun: boolean;
  taskRunning: boolean;
}): "close" | "hide" | "tray" | "ask" {
  if (state.quitting) return "close";
  if (state.platform === "darwin") return "hide";
  if (state.firstRun) return "tray";
  return state.taskRunning ? "ask" : "close";
}
