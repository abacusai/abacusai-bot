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
