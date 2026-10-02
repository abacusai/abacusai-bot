/**
 * The single `"app"` prefs row (spec 01 §8.3): read live, written through
 * the collection (optimistic; settles on main's echo). High-frequency writes
 * (pane widths) go through a 300 ms debouncer first.
 */
import { useLiveQuery } from "@tanstack/react-db";
import { Debouncer } from "@tanstack/react-pacer";

import type { PrefsRow } from "#shared/contract";

import { useCollections, type Collections } from "./index";

/** What the shell renders with before the row arrives (main's defaults). */
export const DEFAULT_PREFS: PrefsRow = {
  id: "app",
  theme: "system",
  language: "system",
  sidebar: { pinned: true, openSection: null },
  pinned: { sessionIds: [], botIds: [] },
  models: { selectedModelId: null, favoriteModelIds: [], perWorkspace: {} },
  defaultMode: "DEFAULT" as PrefsRow["defaultMode"],
  workspaceExpanded: {},
  lastPickedWorkspaceId: null,
  recentFolders: [],
  creditsExhaustedAt: null,
  browserHomepage: null,
  onboardingStep: null,
  dismissals: { referralCardUntil: null, upsell: false },
  panes: {},
  motion: { reduce: "system" },
  sounds: { enabled: true, perEvent: {} },
  updatedAt: new Date(0).toISOString(),
};

/** The live row, or the defaults while loading. */
export const usePrefs = (): PrefsRow => {
  const collections = useCollections();
  const { data } = useLiveQuery(collections.prefs);
  return data?.[0] ?? DEFAULT_PREFS;
};

export type PrefsRecipe = (draft: PrefsRow) => void;

/** Optimistic write of the `"app"` row; resolves once main echoed it. */
export const updatePrefs = async (
  collections: Collections,
  recipe: PrefsRecipe
): Promise<void> => {
  const transaction = collections.prefs.update("app", recipe);
  await transaction.isPersisted.promise;
};

export const useUpdatePrefs = (): ((recipe: PrefsRecipe) => Promise<void>) => {
  const collections = useCollections();
  return (recipe) => updatePrefs(collections, recipe);
};

/**
 * A debounced writer for one pane's width: many drags, one write, 300 ms
 * after the last (spec 01 §7.5).
 */
export const createPaneWidthWriter = (
  collections: Collections,
  pane: string,
  wait = 300
): { write(width: number): void; flush(): void; cancel(): void } => {
  const debouncer = new Debouncer(
    (width: number) => {
      void updatePrefs(collections, (draft) => {
        draft.panes = { ...draft.panes, [pane]: Math.round(width) };
      }).catch(() => undefined);
    },
    { wait }
  );
  return {
    write: (width) => debouncer.maybeExecute(width),
    flush: () => debouncer.flush(),
    cancel: () => debouncer.cancel(),
  };
};
