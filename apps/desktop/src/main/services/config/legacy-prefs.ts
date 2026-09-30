/**
 * The old renderer's durable state (`userData/renderer-state.json`) mapped
 * onto the prefs row (spec 00 C.4). One mapping, three import points: the
 * one-time migration step (`migrations/steps/002-*`), the live legacy sync
 * below (transition only; removed with the old renderer), and the final
 * import at cut-over.
 *
 * Several legacy keys can feed one prefs field (`sidebar` takes `pinned` from
 * `local-code-ui-store` and `openSection` from `sidebar-accordion`), so a
 * field is always composed from every key the old renderer holds, over the
 * field's defaults. That is also what the old renderer shows: a key it does
 * not hold means that part is at its default.
 *
 * Merges go by provenance through `PrefsStore.importLegacy` and
 * `resetLegacy`, never by default-equality. `renderer-state.json` is only
 * ever read here.
 */
import * as v from "valibot";

import { PrefsPatchSchema } from "#shared/contract/db";
import {
  SUPPORTED_LANGUAGES,
  type PrefsField,
  type PrefsPatch,
} from "#shared/contract/rows";

import { PREFS_DEFAULTS, type PrefsStore } from "./prefs-store";

/** Every legacy key that maps to something, and the prefs fields it feeds. */
export const LEGACY_PREFS_KEYS: ReadonlyMap<string, readonly PrefsField[]> =
  new Map<string, readonly PrefsField[]>([
    ["theme", ["theme"]],
    ["abacusai-bot-language", ["language"]],
    [
      "local-code-ui-store",
      [
        "sidebar",
        "models",
        "defaultMode",
        "workspaceExpanded",
        "pinned",
        "lastPickedWorkspaceId",
      ],
    ],
    ["sidebar-accordion", ["sidebar"]],
    ["abacus-credits", ["creditsExhaustedAt"]],
    ["abacusai-bot-code-folder", ["recentFolders"]],
    ["browser.homepage", ["browserHomepage"]],
    ["onboarding.step", ["onboardingStep", "onboardingFlow"]],
    ["referral-card.dismissed-until", ["dismissals"]],
    ["local-code:upsell-dismissed", ["dismissals"]],
  ]);

/** The prefs fields any legacy key feeds, in row order. */
export const LEGACY_PREFS_FIELDS: readonly PrefsField[] = (
  Object.keys(PREFS_DEFAULTS) as PrefsField[]
).filter((field) =>
  Array.from(LEGACY_PREFS_KEYS.values()).some((fields) =>
    fields.includes(field)
  )
);

/** Object fields that several keys fill member by member. */
const MEMBER_FIELDS = new Set<PrefsField>([
  "sidebar",
  "models",
  "pinned",
  "dismissals",
]);

/** What one legacy key says about the fields it feeds. */
export interface LegacyKeyMapping {
  /**
   * Per field: the whole value, or for a member field (`sidebar`, `models`,
   * `pinned`, `dismissals`) the members this key holds. Members the key does
   * not hold take the field's defaults, as the old renderer's zustand merge
   * does.
   */
  values: Partial<Record<PrefsField, unknown>>;
  /** Fields the key names but whose stored value is unusable. */
  invalid: PrefsField[];
}

/**
 * The old renderer's onboarding screens (`onboarding-steps.ts` `STEP_ORDER`;
 * `legacy-prefs.test.ts` checks they match). A stored step outside it reads
 * as none there.
 */
export const LEGACY_ONBOARDING_STEPS: readonly string[] = [
  "auth",
  "welcome",
  "connectors",
  "models",
  "explainer",
];

/**
 * A legacy step id in the new renderer's vocabulary (spec 06 F10, §23.6).
 * Both vocabularies contain `"welcome"` with different meanings, so the
 * import translates before it writes, and marks the row `onboardingFlow = 2`
 * alongside; a step outside the legacy order reads as none.
 */
export const CANONICAL_ONBOARDING_STEPS: Readonly<Record<string, string>> = {
  auth: "welcome",
  welcome: "connected",
  connectors: "connectors",
  models: "models",
  explainer: "first-bot",
};

/** The onboarding vocabulary `onboardingFlow = 2` marks. */
export const ONBOARDING_FLOW = 2;

export const canonicalOnboardingStep = (legacy: string): string | null =>
  LEGACY_ONBOARDING_STEPS.includes(legacy)
    ? (CANONICAL_ONBOARDING_STEPS[legacy] ?? null)
    : null;

/**
 * `browser-homepage.ts`'s `normalizeBrowserHomepage` for a non-blank value
 * (the test checks they agree): a bare host gains `https://`, anything but
 * http(s) is null (the default).
 */
export const normalizeBrowserHomepage = (value: string): string | null => {
  const trimmed = value.trim();
  try {
    const url = new URL(
      /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
    );
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Drops members zustand would not have (absent, so the default applies). */
const defined = (members: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(members).filter(([, value]) => value !== undefined)
  );

/**
 * A zustand `persist()` value, `{ state, version }`. `version` is what the
 * store declares; a stored version that differs, for a store without
 * `migrate`, is discarded by zustand, so it holds nothing.
 */
const zustandState = (
  raw: string,
  storeVersion: number | null
): Record<string, unknown> | "invalid" | "absent" => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "invalid";
  }
  if (!isRecord(parsed) || !isRecord(parsed.state)) return "invalid";
  // zustand compares `stored.version !== options.version`, so a missing
  // version is a mismatch too, and without `migrate` the value is dropped.
  if (storeVersion !== null && parsed.version !== storeVersion) return "absent";
  return parsed.state;
};

const fromZustand = (
  raw: string,
  fields: readonly PrefsField[],
  storeVersion: number | null,
  map: (state: Record<string, unknown>) => LegacyKeyMapping["values"]
): LegacyKeyMapping | null => {
  const state = zustandState(raw, storeVersion);
  if (state === "absent") return null;
  if (state === "invalid") return { values: {}, invalid: [...fields] };
  return { values: map(state), invalid: [] };
};

/** `local-code-ui-store` (code-store.ts, version 4 with `migrate`). */
const mapCodeStore = (
  state: Record<string, unknown>
): LegacyKeyMapping["values"] => {
  // code-store.ts's migrate only deletes fields (isRightPanelVisible,
  // activeRightTab below 3; workspaceSelectedModes below 4) that map to
  // nothing, so every version reads the same way. `codeSidebarTab` is dropped:
  // the new renderer has no equivalent.
  const values: LegacyKeyMapping["values"] = {
    sidebar: defined({ pinned: state.isSidebarVisible }),
    models: defined({
      selectedModelId: state.selectedModelId,
      favoriteModelIds: state.favoriteModelIds,
      perWorkspace: state.workspaceSelectedModelIds,
    }),
    pinned: defined({
      sessionIds: state.pinnedSessionIds,
      botIds: state.pinnedBotIds,
    }),
  };
  if (state.globalSelectedMode !== undefined)
    values.defaultMode = state.globalSelectedMode;
  if (state.workspaceAccordionExpanded !== undefined)
    values.workspaceExpanded = state.workspaceAccordionExpanded;
  if (state.lastPickedWorkspaceId !== undefined)
    values.lastPickedWorkspaceId = state.lastPickedWorkspaceId;
  return values;
};

/**
 * One legacy key's contribution, or null when the key maps to nothing (or
 * holds nothing the old renderer would read). Pure; never throws.
 */
export const mapLegacyKey = (
  key: string,
  raw: string
): LegacyKeyMapping | null => {
  const fields = LEGACY_PREFS_KEYS.get(key);
  if (fields === undefined) return null;
  switch (key) {
    case "theme":
      return raw === "light" || raw === "dark" || raw === "system"
        ? { values: { theme: raw }, invalid: [] }
        : { values: {}, invalid: ["theme"] };
    case "abacusai-bot-language": {
      // As i18n.ts's storedLanguage: an explicit supported code wins; anything
      // else (corrupt, unsupported) falls through to the OS languages, which
      // is the row's "system". The version is not checked there either.
      let code: unknown;
      try {
        const parsed = JSON.parse(raw) as unknown;
        code =
          isRecord(parsed) && isRecord(parsed.state)
            ? parsed.state.languageCode
            : undefined;
      } catch {
        code = undefined;
      }
      const supported = (SUPPORTED_LANGUAGES as readonly unknown[]).includes(
        code
      );
      return {
        values: { language: supported ? code : "system" },
        invalid: [],
      };
    }
    case "local-code-ui-store":
      return fromZustand(raw, fields, null, mapCodeStore);
    case "sidebar-accordion":
      return fromZustand(raw, fields, 0, (state) => ({
        sidebar: defined({ openSection: state.openSection }),
      }));
    case "abacus-credits":
      return fromZustand(raw, fields, 0, (state) =>
        state.exhaustedAt === undefined
          ? {}
          : { creditsExhaustedAt: state.exhaustedAt }
      );
    case "abacusai-bot-code-folder":
      // `currentFolder` is dropped: the URL owns location in the new renderer.
      return fromZustand(raw, fields, 0, (state) =>
        state.recentFolders === undefined
          ? {}
          : { recentFolders: state.recentFolders }
      );
    case "browser.homepage": {
      // As browser-homepage.ts's getBrowserHomepage: blank or not http(s)
      // shows the default (the row's null); anything else is normalised.
      const normalized =
        raw.trim() === "" ? null : normalizeBrowserHomepage(raw);
      return { values: { browserHomepage: normalized }, invalid: [] };
    }
    case "onboarding.step": {
      // As onboarding-flow.tsx: a step it does not know reads as none. A
      // known one is written in the new vocabulary, with its flow marker.
      const step = canonicalOnboardingStep(raw);
      return {
        values: {
          onboardingStep: step,
          onboardingFlow: step == null ? null : ONBOARDING_FLOW,
        },
        invalid: [],
      };
    }
    case "referral-card.dismissed-until": {
      const until = Number(raw);
      return Number.isFinite(until)
        ? { values: { dismissals: { referralCardUntil: until } }, invalid: [] }
        : { values: {}, invalid: ["dismissals"] };
    }
    case "local-code:upsell-dismissed":
      // Presence is the flag (credits-exhausted-card.tsx).
      return { values: { dismissals: { upsell: true } }, invalid: [] };
    default:
      return null;
  }
};

/** The legacy state composed into prefs fields. */
export interface LegacyPrefs {
  /** Fields with a usable legacy value, validated. */
  patch: PrefsPatch;
  /** Fields the old renderer holds nothing for (it shows their defaults). */
  absent: PrefsField[];
  /** Fields it holds something unusable for; left at their current value. */
  invalid: PrefsField[];
  /**
   * Member fields with some unusable keys and some usable ones: imported
   * from the usable ones (in `patch`), and counted as invalid.
   */
  invalidMembers: PrefsField[];
  /** The mapped keys present. */
  keys: string[];
}

const FIELD_SCHEMAS = PrefsPatchSchema.entries;

/**
 * What the old renderer shows for a member no key holds. Only one differs
 * from the prefs default: a fresh old sidebar opens Bots
 * (sidebar-accordion-store.ts), while the new row starts with none.
 */
const legacyBase = (field: PrefsField): unknown =>
  field === "sidebar"
    ? { ...PREFS_DEFAULTS.sidebar, openSection: "bots" }
    : PREFS_DEFAULTS[field];

/**
 * Composes `fields` from every legacy key `read` returns a value for. Keys
 * are applied in `LEGACY_PREFS_KEYS` order.
 */
export const composeLegacyPrefs = (
  read: (key: string) => string | undefined,
  fields: readonly PrefsField[] = LEGACY_PREFS_FIELDS
): LegacyPrefs => {
  const result: LegacyPrefs = {
    patch: {},
    absent: [],
    invalid: [],
    invalidMembers: [],
    keys: [],
  };
  const mappings: LegacyKeyMapping[] = [];
  for (const key of LEGACY_PREFS_KEYS.keys()) {
    const raw = read(key);
    if (raw === undefined) continue;
    const mapping = mapLegacyKey(key, raw);
    if (mapping == null) continue;
    result.keys.push(key);
    mappings.push(mapping);
  }
  for (const field of fields) {
    const contributing = mappings.filter(
      (mapping) => field in mapping.values || mapping.invalid.includes(field)
    );
    if (contributing.length === 0) {
      result.absent.push(field);
      continue;
    }
    const valid = contributing.filter(
      (mapping) => !mapping.invalid.includes(field)
    );
    // A scalar field with any unusable key, or a member field whose every
    // key is unusable, is left at its current value. A member field keeps
    // what its usable keys hold: the old renderer shows the base for the
    // members an unusable key would have held (zustand drops a corrupt
    // store; `Number("abc")` hides nothing).
    if (
      valid.length === 0 ||
      (!MEMBER_FIELDS.has(field) && valid.length < contributing.length)
    ) {
      result.invalid.push(field);
      continue;
    }
    if (valid.length < contributing.length) result.invalidMembers.push(field);
    let value: unknown = structuredClone(legacyBase(field));
    for (const mapping of valid) {
      const part = mapping.values[field];
      value =
        MEMBER_FIELDS.has(field) && isRecord(value) && isRecord(part)
          ? { ...value, ...part }
          : part;
    }
    if (!v.safeParse(FIELD_SCHEMAS[field], value).success) {
      result.invalid.push(field);
      continue;
    }
    (result.patch as Record<string, unknown>)[field] = value;
  }
  return result;
};

export interface LegacyImportStats {
  /** Mapped keys present in the legacy state. */
  keys: number;
  /** Fields that took a legacy value (changed or not). */
  imported: number;
  /** Fields left alone because the user set them in the new UI. */
  keptUser: number;
  /** Fields with an unusable legacy value, left at their current value. */
  invalid: number;
  /** Legacy-sourced fields reset to their defaults (their keys are gone). */
  reset: number;
}

/**
 * Brings `fields` of the prefs row in line with the legacy state, by
 * provenance: a `"user"` field is never touched; a field with a legacy value
 * takes it and becomes `"legacy"`; a `"legacy"` field whose keys are gone
 * goes back to its default.
 */
export const importLegacyPrefs = (
  prefs: Pick<PrefsStore, "importLegacy" | "resetLegacy" | "provenance">,
  read: (key: string) => string | undefined,
  fields: readonly PrefsField[] = LEGACY_PREFS_FIELDS
): LegacyImportStats => {
  const legacy = composeLegacyPrefs(read, fields);
  const provenance = prefs.provenance();
  const named = Object.keys(legacy.patch) as PrefsField[];
  // Provenance is per leaf; a field counts as kept when any leaf of it is
  // the user's (the import skips exactly those leaves).
  const keptUser = named.filter((field) =>
    Object.entries(provenance).some(
      ([leaf, mark]) =>
        mark === "user" && (leaf === field || leaf.startsWith(`${field}.`))
    )
  );
  const { invalid } = prefs.importLegacy(legacy.patch);
  const reset = prefs.resetLegacy(legacy.absent);
  return {
    keys: legacy.keys.length,
    imported: named.length - keptUser.length - invalid,
    keptUser: keptUser.length,
    invalid: legacy.invalid.length + legacy.invalidMembers.length + invalid,
    reset: reset.length,
  };
};

/**
 * The old renderer's sound opt-out lives in `config.json`
 * (`notificationSoundDisabled`, `settings.ts` `readNotificationSettings`),
 * not in its durable state (spec 05 §31.5 i). An opt-out is imported into
 * `sounds.enabled = false` as `"legacy"`; once it is lifted, a legacy-sourced
 * `false` goes back to the default. A `"user"` leaf is never touched.
 * Returns what happened.
 */
export const importLegacySoundOptOut = (
  prefs: Pick<PrefsStore, "importLegacy" | "resetLegacy" | "provenance">,
  soundDisabled: unknown
): "imported" | "kept-user" | "reset" | "none" => {
  const mark = prefs.provenance()["sounds.enabled"];
  if (mark === "user") return soundDisabled === true ? "kept-user" : "none";
  if (soundDisabled === true) {
    prefs.importLegacy({ sounds: { enabled: false } });
    return "imported";
  }
  if (mark !== "legacy") return "none";
  // Only `sounds.enabled` is ever legacy-sourced, so resetting the group's
  // legacy leaves resets exactly it.
  prefs.resetLegacy(["sounds"]);
  return "reset";
};

/** `config.json`'s sound opt-out and its writes (`setNotificationSettings`). */
export interface LegacySoundSource {
  read(): unknown;
  onWrite(listener: () => void): () => void;
}

/** The legacy side of the live sync: `RendererStateStore`'s read face. */
export interface LegacyStateSource {
  get(key: string): string | undefined;
  onSet(listener: (key: string, value: string | null) => void): () => void;
}

/**
 * The live legacy sync (spec 00 C.4 point 2), for the transition only: the
 * old renderer stays the shipped UI until the cut-over, so every change it
 * makes to a mapped key is carried into `prefs.json` as it happens. Starts
 * with a full import, which also covers a launch whose migration step failed
 * and anything an older build changed while this one was not running.
 * Returns the unsubscribe.
 */
export const installLegacyPrefsSync = (
  legacy: LegacyStateSource,
  prefs: Pick<PrefsStore, "importLegacy" | "resetLegacy" | "provenance">,
  log: (message: string, error: unknown) => void = (message, error) =>
    console.error(message, error),
  sound?: LegacySoundSource
): (() => void) => {
  const read = (key: string): string | undefined => legacy.get(key);
  const syncSound = (): void => {
    if (sound == null) return;
    try {
      importLegacySoundOptOut(prefs, sound.read());
    } catch (error) {
      log("[legacy-prefs] sound opt-out sync failed", error);
    }
  };
  try {
    importLegacyPrefs(prefs, read);
  } catch (error) {
    log("[legacy-prefs] startup import failed", error);
  }
  syncSound();
  const offState = legacy.onSet((key) => {
    const fields = LEGACY_PREFS_KEYS.get(key);
    if (fields === undefined) return;
    try {
      importLegacyPrefs(prefs, read, fields);
    } catch (error) {
      log(`[legacy-prefs] sync of ${key} failed`, error);
    }
  });
  const offSound = sound?.onWrite(syncSound) ?? (() => undefined);
  return () => {
    offState();
    offSound();
  };
};
