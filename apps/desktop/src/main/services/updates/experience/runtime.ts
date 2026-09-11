/**
 * Composition of the experience runtime: store, app:// handler, TUF updater.
 * Additive: with no trusted root or installed experience every path behaves
 * as on the baseline.
 */
import { setActiveExperienceStore } from "./active-experience";
import { rendererUrl, handleAppScheme } from "./app-protocol";
import { ExperienceStore } from "./experience-store";
import { ExperienceUpdater } from "./experience-updater";

export { registerAppScheme } from "./app-protocol";

export interface ExperienceRuntime {
  activeRendererUrl(): URL | null;
  dispose(): void;
  readonly store: ExperienceStore;
}

export const initializeExperienceRuntime = async (options: {
  /** Called after an activation whose renderer bundle changed. */
  onRendererChanged: (version: string) => void;
}): Promise<ExperienceRuntime> => {
  const store = new ExperienceStore();

  await store.initialize();
  setActiveExperienceStore(store);
  const unhandle = handleAppScheme(store);
  const updater = new ExperienceUpdater({
    onRendererChanged: options.onRendererChanged,
    store,
  });

  updater.start();

  return {
    activeRendererUrl: () => {
      const version = store.version;

      return version === null ? null : rendererUrl(version);
    },
    dispose: () => {
      updater.dispose();
      unhandle();
      setActiveExperienceStore(null);
    },
    store,
  };
};
