import type { PrefsPatch, PrefsRow } from "@abacus-ai/contract/contract/rows";
/**
 * The single `"app"` prefs row (spec 01 §8.3): read live, written as a
 * `PrefsPatch` through `db.updatePrefs` (spec 00 B.2): only the leaves a
 * caller names travel, so each becomes the user's and no other leaf loses its
 * legacy sync. High-frequency writes (pane widths) go through a 300 ms
 * debouncer first.
 */
import { useLiveQuery } from "@tanstack/react-db";
import { Debouncer } from "@tanstack/react-pacer";

import { useCollections, useDb, type Db } from "./index";

/** What the shell renders with before the row arrives (main's defaults). */
export const DEFAULT_PREFS: Required<PrefsRow> & {
  sounds: Required<PrefsRow["sounds"]>;
} = {
  id: "app",
  theme: "system",
  language: "system",
  sidebar: { pinned: true, openSection: null },
  pinned: { sessionIds: [], botIds: [] },
  models: { selectedModelId: null, favoriteModelIds: [], perWorkspace: {} },
  defaultMode: "YOLO" as PrefsRow["defaultMode"],
  workspaceExpanded: {},
  lastPickedWorkspaceId: null,
  recentFolders: [],
  creditsExhaustedAt: null,
  browserHomepage: null,
  onboardingStep: null,
  dismissals: { referralCardUntil: null, upsell: false, whatsappIntroAt: null },
  panes: {},
  motion: { reduce: "system" },
  sounds: {
    enabled: true,
    perEvent: {},
    perBot: {},
    quietHours: { enabled: false, start: "22:00", end: "08:00" },
  },
  keymap: {},
  appearance: {
    textSize: 14,
    bubbleTint: true,
    palette: "default",
    accent: null,
    contrast: "system",
    radius: "default",
    uiFont: "",
    codeFont: "",
    codeFontSize: 12,
    translucency: true,
    custom: null,
  },
  notch: {
    enabled: true,
    haptics: true,
    idleVisible: true,
    extraDisplays: false,
    showInNotch: true,
  },
  tour: { status: "unseen", at: null },
  onboardingFlow: null,
  onboardingExit: null,
  onboardingPairing: [],
  updatedAt: new Date(0).toISOString(),
};

/** The live row, or the defaults while loading. */
export const usePrefs = (): PrefsRow => {
  const collections = useCollections();
  const { data } = useLiveQuery(collections.prefs);
  return data?.[0] ?? DEFAULT_PREFS;
};

/** The row as it is now, outside React. */
const currentPrefs = (db: Pick<Db, "collections">): PrefsRow =>
  db.collections.prefs.get("app") ?? DEFAULT_PREFS;

/** Optimistic write of named leaves; resolves once main echoed it. */
export const useUpdatePrefs = (): ((patch: PrefsPatch) => Promise<void>) =>
  useDb().updatePrefs;

/**
 * A debounced writer for one pane's width: many drags, one write, 300 ms
 * after the last (spec 01 §7.5). `panes` is one leaf (a record), so the
 * write carries the other panes' widths as they are.
 */
export const createPaneWidthWriter = (
  db: Pick<Db, "collections" | "updatePrefs">,
  pane: string,
  wait = 300
): { write(width: number): void; flush(): void; cancel(): void } => {
  const debouncer = new Debouncer(
    (width: number) => {
      void db
        .updatePrefs({
          panes: { ...currentPrefs(db).panes, [pane]: Math.round(width) },
        })
        .catch(() => undefined);
    },
    { wait }
  );
  return {
    write: (width) => debouncer.maybeExecute(width),
    flush: () => debouncer.flush(),
    cancel: () => debouncer.cancel(),
  };
};
