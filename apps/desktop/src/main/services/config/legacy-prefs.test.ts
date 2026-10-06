/**
 * The C.4 mapping (`mapLegacyKey`, composition over several keys) and C-T8,
 * the live legacy sync: `RendererStateStore` changes reach `prefs.json` and
 * the `db.prefs` table by provenance, and `renderer-state.json` is never
 * written by the sync.
 */

import os from "node:os";

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir(), on: vi.fn() },
  ipcMain: { on: vi.fn() },
}));

import {
  composeLegacyPrefs,
  importLegacyPrefs,
  LEGACY_ONBOARDING_STEPS,
  LEGACY_PREFS_FIELDS,
  mapLegacyKey,
  normalizeBrowserHomepage,
} from "./legacy-prefs";
import { PREFS_DEFAULTS, PrefsStore } from "./prefs-store";

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

  it("drops a zustand value with no version, as zustand does", () => {
    expect(
      mapLegacyKey(
        "sidebar-accordion",
        JSON.stringify({ state: { openSection: "bots" } })
      )
    ).toBeNull();
  });

  it("reads onboarding.step as the old UI does: an unknown step is none", () => {
    expect(mapLegacyKey("onboarding.step", "models")?.values).toEqual({
      onboardingStep: "models",
      onboardingFlow: 2,
    });
    expect(mapLegacyKey("onboarding.step", "connect-whatsapp")?.values).toEqual(
      { onboardingStep: null, onboardingFlow: null }
    );
  });

  // R6-T5 (main): legacy ids are written in the new vocabulary, flow 2.
  it("canonicalises every legacy onboarding step (spec 06 F10)", () => {
    const canonical = (raw: string) =>
      mapLegacyKey("onboarding.step", raw)?.values;
    expect(canonical("auth")).toEqual({
      onboardingStep: "welcome",
      onboardingFlow: 2,
    });
    expect(canonical("welcome")).toEqual({
      onboardingStep: "connected",
      onboardingFlow: 2,
    });
    expect(canonical("connectors")?.onboardingStep).toBe("connectors");
    expect(canonical("models")?.onboardingStep).toBe("models");
    expect(canonical("explainer")?.onboardingStep).toBe("first-bot");
    // New-vocabulary ids are not legacy ids: outside the order, none.
    expect(canonical("first-bot")).toEqual({
      onboardingStep: null,
      onboardingFlow: null,
    });
    expect(canonical("")).toEqual({
      onboardingStep: null,
      onboardingFlow: null,
    });
  });

  it('the legacy "welcome" becomes connected; the new renderer\'s stays welcome', () => {
    const prefs = new PrefsStore({ file: null });
    importLegacyPrefs(prefs, reader({ "onboarding.step": "welcome" }));
    expect(prefs.get()).toMatchObject({
      onboardingStep: "connected",
      onboardingFlow: 2,
    });

    // renderer writes its own "welcome" as a user patch; a later legacy
    // write cannot move it.
    prefs.update({ onboardingStep: "welcome", onboardingFlow: 2 });
    importLegacyPrefs(prefs, reader({ "onboarding.step": "explainer" }));
    expect(prefs.get()).toMatchObject({
      onboardingStep: "welcome",
      onboardingFlow: 2,
    });
    expect(prefs.provenance()).toMatchObject({
      onboardingStep: "user",
      onboardingFlow: "user",
    });
  });

  it("reads browser.homepage as the old UI does", () => {
    const home = (raw: string) =>
      mapLegacyKey("browser.homepage", raw)?.values.browserHomepage;
    expect(home("  ")).toBeNull();
    expect(home("example.com")).toBe("https://example.com/");
    expect(home("http://x.test/a")).toBe("http://x.test/a");
    expect(home("javascript:alert(1)")).toBeNull();
    expect(home("file:///etc/passwd")).toBeNull();
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
      whatsappIntroAt: null,
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

  it("keeps a member field's usable keys when another key for it is unusable", () => {
    const legacy = composeLegacyPrefs(
      reader({
        "referral-card.dismissed-until": "abc",
        "local-code:upsell-dismissed": "1",
        "local-code-ui-store": "{corrupt",
        "sidebar-accordion": zustand({ openSection: "sessions" }),
      })
    );
    // The old UI: NaN shows the card (null), the upsell stays dismissed.
    expect(legacy.patch.dismissals).toEqual({
      referralCardUntil: null,
      upsell: true,
      whatsappIntroAt: null,
    });
    // A corrupt code store reads as its defaults there; the accordion holds.
    expect(legacy.patch.sidebar).toEqual({
      pinned: true,
      openSection: "sessions",
    });
    expect(legacy.invalidMembers).toEqual(["sidebar", "dismissals"]);
    // Fields only the corrupt store feeds stay invalid (left as they are).
    expect(legacy.invalid).toEqual(
      expect.arrayContaining(["models", "pinned", "defaultMode"])
    );
    expect(legacy.patch.models).toBeUndefined();
  });

  it("keeps a member field invalid when every key for it is unusable", () => {
    const legacy = composeLegacyPrefs(
      reader({ "referral-card.dismissed-until": "abc" })
    );
    expect(legacy.invalid).toEqual(["dismissals"]);
    expect(legacy.patch.dismissals).toBeUndefined();
  });

  it("matches the old renderer's onboarding steps and homepage rule", () => {
    // Frozen from C5 d8bccf17. Homepage scheme/protocol cases below preserve its rule.
    expect(LEGACY_ONBOARDING_STEPS).toEqual([
      "auth",
      "welcome",
      "connectors",
      "models",
      "explainer",
    ]);
    expect(normalizeBrowserHomepage("example.com")).toBe(
      "https://example.com/"
    );
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
      "onboardingFlow",
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
    expect(prefs.get().onboardingStep).toBe("connected");
    expect(stats).toMatchObject({ keys: 2, imported: 2, keptUser: 1 });

    // onboarding.step is gone: the legacy fields reset; theme stays the user's.
    const after = importLegacyPrefs(prefs, reader({}));
    expect(after.reset).toBe(2);
    expect(prefs.get().onboardingStep).toBeNull();
    expect(prefs.get().onboardingFlow).toBeNull();
    expect(prefs.provenance()).toMatchObject({
      theme: "user",
      onboardingStep: "default",
      onboardingFlow: "default",
    });
  });
});

// R5-T28 (main): `notificationSoundDisabled` into `sounds.enabled`.
