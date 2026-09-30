/**
 * The C.4 mapping (`mapLegacyKey`, composition over several keys) and C-T8,
 * the live legacy sync: `RendererStateStore` changes reach `prefs.json` and
 * the `db.prefs` table by provenance, and `renderer-state.json` is never
 * written by the sync.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir(), on: vi.fn() },
  ipcMain: { on: vi.fn() },
}));

import { AgentMode } from "#shared/agent-types";

import { MainEventBus } from "../../rpc/event-bus";
import { createTables, type Tables } from "../../rpc/tables";
import type { TableSources } from "../../rpc/tables/sources";
import {
  composeLegacyPrefs,
  importLegacyPrefs,
  installLegacyPrefsSync,
  LEGACY_PREFS_FIELDS,
  mapLegacyKey,
} from "./legacy-prefs";
import { PREFS_DEFAULTS, PrefsStore } from "./prefs-store";
import { RendererStateStore } from "./renderer-state";

const zustand = (state: unknown, version = 0): string =>
  JSON.stringify({ state, version });

const reader =
  (state: Record<string, string>) =>
  (key: string): string | undefined =>
    Object.hasOwn(state, key) ? state[key] : undefined;

describe("mapLegacyKey", () => {
  it("maps nothing for unmapped keys", () => {
    expect(mapLegacyKey("durable-storage.migrated", "1")).toBeNull();
    expect(mapLegacyKey("abacusai-bot.promptSnippets", "[]")).toBeNull();
    expect(mapLegacyKey("composer.draft:ws-1", "hello")).toBeNull();
    expect(mapLegacyKey("constructor", "x")).toBeNull();
    expect(mapLegacyKey("toString", "x")).toBeNull();
  });

  it("maps the raw theme and refuses an unknown one", () => {
    expect(mapLegacyKey("theme", "dark")).toEqual({
      values: { theme: "dark" },
      invalid: [],
    });
    expect(mapLegacyKey("theme", "purple")).toEqual({
      values: {},
      invalid: ["theme"],
    });
  });

  it("maps an explicit supported language, anything else to system", () => {
    const language = (raw: string) =>
      mapLegacyKey("abacusai-bot-language", raw)?.values.language;
    expect(language(zustand({ languageCode: "de-DE" }))).toBe("de-DE");
    expect(language(zustand({ languageCode: "es-419" }))).toBe("es-419");
    expect(language(zustand({ languageCode: "xx-YY" }))).toBe("system");
    expect(language(zustand({}))).toBe("system");
    expect(language("{not json")).toBe("system");
    // i18n.ts reads the code whatever the stored version is.
    expect(language(zustand({ languageCode: "ja-JP" }, 3))).toBe("ja-JP");
  });

  it("marks every field of an unreadable zustand value invalid", () => {
    expect(mapLegacyKey("local-code-ui-store", "{nope")?.invalid).toEqual([
      "sidebar",
      "models",
      "defaultMode",
      "workspaceExpanded",
      "pinned",
      "lastPickedWorkspaceId",
    ]);
    expect(
      mapLegacyKey("sidebar-accordion", JSON.stringify({ state: 1 }))?.invalid
    ).toEqual(["sidebar"]);
  });

  it("drops a zustand value of another version for a store without migrate", () => {
    expect(
      mapLegacyKey("sidebar-accordion", zustand({ openSection: "bots" }, 2))
    ).toBeNull();
  });

  it("reads dismissals", () => {
    expect(
      mapLegacyKey("referral-card.dismissed-until", "1790000000000")?.values
    ).toEqual({ dismissals: { referralCardUntil: 1790000000000 } });
    expect(
      mapLegacyKey("referral-card.dismissed-until", "soon")?.invalid
    ).toEqual(["dismissals"]);
    expect(mapLegacyKey("local-code:upsell-dismissed", "1")?.values).toEqual({
      dismissals: { upsell: true },
    });
  });
});

describe("composeLegacyPrefs", () => {
  it("composes a field from several keys over the old renderer's defaults", () => {
    const legacy = composeLegacyPrefs(
      reader({
        "local-code-ui-store": zustand({ isSidebarVisible: false }, 4),
        "local-code:upsell-dismissed": "1",
      })
    );
    // No sidebar-accordion: the old sidebar shows Bots.
    expect(legacy.patch.sidebar).toEqual({
      pinned: false,
      openSection: "bots",
    });
    expect(legacy.patch.dismissals).toEqual({
      referralCardUntil: null,
      upsell: true,
    });
    expect(legacy.patch.models).toEqual(PREFS_DEFAULTS.models);
    expect(legacy.absent).toContain("theme");
    expect(legacy.keys).toEqual([
      "local-code-ui-store",
      "local-code:upsell-dismissed",
    ]);
  });

  it("skips a field whose value does not validate, not the row", () => {
    const legacy = composeLegacyPrefs(
      reader({
        "local-code-ui-store": zustand(
          {
            favoriteModelIds: "not-a-list",
            globalSelectedMode: "WARP",
            pinnedSessionIds: ["s-1"],
          },
          4
        ),
        "abacusai-bot-code-folder": zustand({
          recentFolders: ["a", "b", "c", "d", "e", "f"],
        }),
      })
    );
    expect(legacy.invalid).toEqual(["models", "defaultMode", "recentFolders"]);
    expect(legacy.patch.pinned).toEqual({ sessionIds: ["s-1"], botIds: [] });
  });

  it("covers every field some key feeds", () => {
    expect(LEGACY_PREFS_FIELDS).toEqual([
      "theme",
      "language",
      "sidebar",
      "pinned",
      "models",
      "defaultMode",
      "workspaceExpanded",
      "lastPickedWorkspaceId",
      "recentFolders",
      "creditsExhaustedAt",
      "browserHomepage",
      "onboardingStep",
      "dismissals",
    ]);
  });
});

describe("importLegacyPrefs", () => {
  it("never touches a user field, resets only legacy ones", () => {
    const prefs = new PrefsStore({ file: null });
    prefs.update({ theme: "system" });
    const stats = importLegacyPrefs(
      prefs,
      reader({ theme: "dark", "onboarding.step": "welcome" })
    );
    expect(prefs.get().theme).toBe("system");
    expect(prefs.get().onboardingStep).toBe("welcome");
    expect(stats).toMatchObject({ keys: 2, imported: 1, keptUser: 1 });

    // onboarding.step is gone: the legacy field resets; theme stays the user's.
    const after = importLegacyPrefs(prefs, reader({}));
    expect(after.reset).toBe(1);
    expect(prefs.get().onboardingStep).toBeNull();
    expect(prefs.provenance()).toMatchObject({
      theme: "user",
      onboardingStep: "default",
    });
  });
});

describe("C-T8 live legacy sync", () => {
  let dir: string;
  let stateFile: string;
  let prefsFile: string;
  let tables: Tables | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-prefs-"));
    stateFile = path.join(dir, "renderer-state.json");
    prefsFile = path.join(dir, "prefs.json");
  });

  afterEach(() => {
    tables?.dispose();
    tables = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const noHook = () => () => undefined;
  const sources = {
    listAllAgentSessions: () => [],
    listSessionTurnStates: () => [],
    onSessionsChanged: noHook,
    listBots: () => [],
    onBotsWritten: noHook,
    listRoutines: () => [],
    onRoutinesWritten: noHook,
    listSessionArtifacts: () => [],
    listMemories: () => [],
    listBotMemories: () => [],
    getMetadata: () => ({
      workspaces: [],
      activeWorkspaceId: null,
      materialIconsBasePath: null,
      lastUpdatedAt: "",
    }),
    onWorkspacesChanged: noHook,
    getGitState: () => {
      throw new Error("unused");
    },
    botHome: () => dir,
  } as unknown as TableSources;

  const setup = () => {
    const prefs = new PrefsStore({ file: prefsFile });
    tables = createTables({
      bus: new MainEventBus(),
      sources,
      prefsStore: prefs,
      watchMemories: false,
      routinesClockMs: null,
    });
    const state = new RendererStateStore(stateFile);
    const off = installLegacyPrefsSync(state, prefs);
    return { prefs, state, off, tables };
  };

  const storedPrefs = () =>
    JSON.parse(fs.readFileSync(prefsFile, "utf8")) as {
      row: Record<string, unknown>;
      provenance: Record<string, string>;
    };

  it("carries set() into prefs.json and publishes a db.prefs change", async () => {
    const { state, tables } = setup();
    tables.prefs.snapshot();
    const stream = tables.prefs.subscribe();
    await stream.next(); // hello

    state.set("theme", "dark");

    const batch = await stream.next();
    expect(batch.done).toBe(false);
    expect(JSON.stringify(batch.value)).toContain('"theme":"dark"');
    expect(storedPrefs().row.theme).toBe("dark");
    expect(storedPrefs().provenance.theme).toBe("legacy");
    await stream.return?.(undefined);
  });

  it("leaves a user field alone and resets only legacy fields on removal", () => {
    const { prefs, state } = setup();
    prefs.update({ theme: "system" });
    state.set("theme", "dark");
    expect(prefs.get().theme).toBe("system");

    state.set(
      "local-code-ui-store",
      zustand(
        { globalSelectedMode: AgentMode.PlanMode, pinnedBotIds: ["b"] },
        4
      )
    );
    state.set("sidebar-accordion", zustand({ openSection: "routines" }));
    expect(prefs.get()).toMatchObject({
      defaultMode: AgentMode.PlanMode,
      pinned: { sessionIds: [], botIds: ["b"] },
      sidebar: { pinned: true, openSection: "routines" },
    });

    // Only the accordion's member goes back to what the old UI shows.
    state.set("sidebar-accordion", null);
    expect(prefs.get().sidebar).toEqual({ pinned: true, openSection: "bots" });

    state.set("theme", null);
    state.clear();
    expect(prefs.get()).toMatchObject({
      theme: "system",
      defaultMode: PREFS_DEFAULTS.defaultMode,
      pinned: PREFS_DEFAULTS.pinned,
      sidebar: PREFS_DEFAULTS.sidebar,
    });
    expect(prefs.provenance()).toMatchObject({
      theme: "user",
      defaultMode: "default",
      "sidebar.pinned": "default",
      "sidebar.openSection": "default",
    });
  });

  it("imports the whole legacy state at install", () => {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        theme: "light",
        "abacusai-bot-language": zustand({ languageCode: "fr-FR" }),
      })
    );
    const { prefs } = setup();
    expect(prefs.get()).toMatchObject({ theme: "light", language: "fr-FR" });
  });

  it("ignores unmapped keys and never writes renderer-state.json", () => {
    const { prefs, state } = setup();
    state.set("composer.draft:ws-1", "half a thought");
    state.set("durable-storage.migrated", "1");
    expect(fs.existsSync(prefsFile)).toBe(false);
    expect(prefs.provenance().theme).toBe("default");
    // The store's own debounced write is the only writer of its file.
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  it("stops after unsubscribe and survives a throwing prefs store", () => {
    const { prefs, state, off } = setup();
    off();
    state.set("theme", "dark");
    expect(prefs.get().theme).toBe("system");

    const log = vi.fn();
    const broken = {
      provenance: () => {
        throw new Error("boom");
      },
      importLegacy: vi.fn(),
      resetLegacy: vi.fn(),
    };
    installLegacyPrefsSync(state, broken as never, log);
    expect(() => state.set("theme", "light")).not.toThrow();
    expect(log).toHaveBeenCalledTimes(2);
  });
});
