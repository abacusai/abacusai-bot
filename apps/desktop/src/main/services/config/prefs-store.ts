/**
 * The new renderer's preferences (spec 00 B.2): one row, `"app"`, in
 * `~/.abacusai-bot/prefs.json`, written atomically. Main owns it; the renderer
 * reads it as the `db.prefs` table and writes it through `db.prefs.update`.
 *
 * The file is `{ row, provenance }`. Provenance says who last set each
 * **leaf** (a scalar field such as `theme`, or one leaf of a group such as
 * `sidebar.pinned`): `"default"` (never written), `"legacy"` (imported from
 * the old renderer's durable state) or `"user"` (chosen in the new UI). A
 * legacy import never overwrites a `"user"` leaf, so an explicit choice
 * survives even when it equals the default, and a sibling leaf the user never
 * touched keeps following the old renderer (C.4 maps two legacy keys into
 * `sidebar` and two into `dismissals`). Provenance never reaches the renderer.
 *
 * `update`, `importLegacy` and `resetLegacy` (its removal half) are the only
 * writers, and so the only places provenance is set. A write is staged,
 * persisted, and only then published in memory: a failed write changes
 * nothing, so a retry writes again.
 */
import fs from "fs";
import path from "path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";
import * as v from "valibot";

import { AgentMode } from "@abacus-ai/contract/agent-types";
import {
  PREFS_GROUP_ENTRIES,
  PREFS_SCALAR_ENTRIES,
  PrefsPatchSchema,
} from "@abacus-ai/contract/contract/db";
import type {
  PrefsField,
  PrefsGroup,
  PrefsLeaf,
  PrefsPatch,
  PrefsRow,
} from "@abacus-ai/contract/contract/rows";

import { abacusBotHome } from "../../paths";

export type PrefsProvenance = "default" | "legacy" | "user";

/** Per leaf (`"theme"`, `"sidebar.pinned"`, …). */
export type PrefsProvenanceMap = Record<PrefsLeaf, PrefsProvenance>;

/** Every field present: main's rows always carry the whole shape. */
type PrefsValues = Required<Omit<PrefsRow, "id" | "updatedAt">> & {
  sounds: Required<PrefsRow["sounds"]>;
};

const DEFAULTS: PrefsValues = {
  theme: "system",
  // Follows the OS until the user picks (spec 01 §9.2).
  language: "system",
  sidebar: { pinned: true, openSection: null },
  pinned: { sessionIds: [], botIds: [] },
  models: { selectedModelId: null, favoriteModelIds: [], perWorkspace: {} },
  // As code-store.ts's `globalSelectedMode`.
  defaultMode: AgentMode.Yolo,
  workspaceExpanded: {},
  lastPickedWorkspaceId: null,
  recentFolders: [],
  creditsExhaustedAt: null,
  browserHomepage: null,
  onboardingStep: null,
  dismissals: { referralCardUntil: null, upsell: false },
  panes: {},
  motion: { reduce: "system" },
  sounds: {
    enabled: true,
    perEvent: {},
    perBot: {},
    quietHours: { enabled: false, start: "22:00", end: "08:00" },
  },
  // Spec 05 §31.5 a: none of these exist in the old renderer (no legacy map).
  keymap: {},
  appearance: { textSize: 14, bubbleTint: true },
  // Spec 06 §23.5 b (`haptics` is revisited by R6-T31).
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
};

/** What a field is before anyone sets it. Mirrors the old renderer's defaults. */
export const PREFS_DEFAULTS: Readonly<PrefsValues> = Object.freeze(DEFAULTS);

export const PREFS_FIELDS = Object.keys(PREFS_DEFAULTS) as PrefsField[];

const isGroup = (field: string): field is PrefsGroup =>
  Object.hasOwn(PREFS_GROUP_ENTRIES, field);

/** Every provenance-tracked leaf, in row order. */
export const PREFS_LEAVES: PrefsLeaf[] = PREFS_FIELDS.flatMap((field) =>
  isGroup(field)
    ? Object.keys(PREFS_GROUP_ENTRIES[field]).map(
        (leaf) => `${field}.${leaf}` as PrefsLeaf
      )
    : [field as PrefsLeaf]
);

const LEAF_SET = new Set<string>(PREFS_LEAVES);

const leafSchema = (leaf: PrefsLeaf): v.GenericSchema => {
  const [field, key] = leaf.split(".") as [string, string | undefined];
  if (key == null)
    return PREFS_SCALAR_ENTRIES[field as keyof typeof PREFS_SCALAR_ENTRIES];
  return (PREFS_GROUP_ENTRIES[field as PrefsGroup] as v.ObjectEntries)[key]!;
};

/** A leaf's value in a row (or a stored, unvalidated object). */
export const getPrefsLeaf = (row: object, leaf: PrefsLeaf): unknown => {
  const [field, key] = leaf.split(".") as [string, string | undefined];
  const value = (row as Record<string, unknown>)[field];
  if (key == null) return value;
  return value != null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
};

const setLeaf = (row: PrefsRow, leaf: PrefsLeaf, value: unknown): void => {
  const [field, key] = leaf.split(".") as [string, string | undefined];
  const record = row as unknown as Record<string, unknown>;
  if (key == null) record[field] = value;
  else (record[field] as Record<string, unknown>)[key] = value;
};

/** A leaf value that no longer validates falls back to its default. */
const validLeaf = (leaf: PrefsLeaf, value: unknown): boolean =>
  value !== undefined && v.safeParse(leafSchema(leaf), value).success;

/** A patch's defined leaves, and how many of its parts named no leaf. */
const leavesOf = (
  patch: PrefsPatch
): { leaves: [PrefsLeaf, unknown][]; unknown: number } => {
  const leaves: [PrefsLeaf, unknown][] = [];
  let unknown = 0;
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!PREFS_FIELDS.includes(field as PrefsField)) {
      unknown += 1;
      continue;
    }
    if (!isGroup(field)) {
      leaves.push([field as PrefsLeaf, value]);
      continue;
    }
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      unknown += 1;
      continue;
    }
    for (const [key, inner] of Object.entries(value)) {
      if (inner === undefined) continue;
      const leaf = `${field}.${key}`;
      if (LEAF_SET.has(leaf)) leaves.push([leaf as PrefsLeaf, inner]);
      else unknown += 1;
    }
  }
  return { leaves, unknown };
};

const EPOCH_ISO = new Date(0).toISOString();

export const prefsFile = (): string => path.join(abacusBotHome(), "prefs.json");

const clone = <T>(value: T): T => structuredClone(value);

const defaultRow = (): PrefsRow => ({
  id: "app",
  ...clone(PREFS_DEFAULTS as PrefsValues),
  updatedAt: EPOCH_ISO,
});

const defaultProvenance = (): PrefsProvenanceMap =>
  Object.fromEntries(
    PREFS_LEAVES.map((leaf) => [leaf, "default"])
  ) as PrefsProvenanceMap;

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export type PrefsChangeListener = (row: PrefsRow, previous: PrefsRow) => void;

export interface PrefsStoreOptions {
  /** Null keeps everything in memory (tests, fakes). */
  file?: string | null;
  now?: () => Date;
}

export class PrefsStore {
  readonly #file: string | null;
  readonly #now: () => Date;
  readonly #listeners = new Set<PrefsChangeListener>();
  #row: PrefsRow | null = null;
  #provenance: PrefsProvenanceMap = defaultProvenance();

  constructor(options: PrefsStoreOptions = {}) {
    this.#file = options.file === undefined ? prefsFile() : options.file;
    this.#now = options.now ?? (() => new Date());
  }

  /** The row; defaults on first read when no file exists yet. */
  get(): PrefsRow {
    return clone(this.#load());
  }

  /** Who set each leaf. */
  provenance(): PrefsProvenanceMap {
    this.#load();
    return { ...this.#provenance };
  }

  /**
   * The new UI's write: every leaf the patch names becomes `"user"`, even
   * when its value equals what is stored (an explicit choice). A group
   * names only the leaves it carries.
   */
  update(patch: PrefsPatch): PrefsRow {
    const parsed = v.parse(PrefsPatchSchema, patch) as PrefsPatch;
    return this.#apply(leavesOf(parsed).leaves, "user");
  }

  /**
   * The old renderer's value for some leaves (spec 00 C.4). A leaf the user
   * set in the new UI is left alone; every other leaf it names takes the
   * value and becomes `"legacy"`. A group may carry any subset of its
   * leaves; its siblings are untouched. Invalid leaves (and unknown fields
   * or leaves) are skipped and counted, never the row.
   */
  importLegacy(patch: PrefsPatch): { row: PrefsRow; invalid: number } {
    this.#load();
    const { leaves, unknown } = leavesOf(patch);
    let invalid = unknown;
    const accepted: [PrefsLeaf, unknown][] = [];
    for (const [leaf, value] of leaves) {
      if (!validLeaf(leaf, value)) {
        invalid += 1;
        continue;
      }
      if (this.#provenance[leaf] === "user") continue;
      accepted.push([leaf, value]);
    }
    return { row: this.#apply(accepted, "legacy"), invalid };
  }

  /**
   * The old renderer dropped the keys behind these fields (spec 00 C.4): each
   * one whose value came from it goes back to its default. A field the user
   * set, or never set, is left alone. Returns the fields reset.
   */
  resetLegacy(fields: readonly PrefsField[]): PrefsField[] {
    this.#load();
    const defaults = defaultRow();
    const leaves: [PrefsLeaf, unknown][] = [];
    const reset: PrefsField[] = [];
    for (const field of fields) {
      if (!PREFS_FIELDS.includes(field)) continue;
      const own = PREFS_LEAVES.filter(
        (leaf) => leaf === field || leaf.startsWith(`${field}.`)
      ).filter((leaf) => this.#provenance[leaf] === "legacy");
      if (own.length === 0) continue;
      reset.push(field);
      for (const leaf of own)
        leaves.push([leaf, clone(getPrefsLeaf(defaults, leaf))]);
    }
    if (leaves.length === 0) return [];
    this.#apply(leaves, "default");
    return reset;
  }

  /** Called after every write that changed the row. */
  onChanged(listener: PrefsChangeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Stage, persist, then publish: a failed write leaves memory as it was. */
  #apply(leaves: [PrefsLeaf, unknown][], mark: PrefsProvenance): PrefsRow {
    const previous = this.#load();
    const next: PrefsRow = clone(previous);
    const provenance: PrefsProvenanceMap = { ...this.#provenance };
    let rowChanged = false;
    let provenanceChanged = false;
    for (const [leaf, value] of leaves) {
      if (!same(getPrefsLeaf(next, leaf), value)) {
        setLeaf(next, leaf, clone(value));
        rowChanged = true;
      }
      if (provenance[leaf] !== mark) {
        provenance[leaf] = mark;
        provenanceChanged = true;
      }
    }
    if (!rowChanged && !provenanceChanged) return clone(previous);
    if (rowChanged) next.updatedAt = this.#now().toISOString();
    this.#persist(next, provenance);
    this.#row = next;
    this.#provenance = provenance;
    if (rowChanged) {
      for (const listener of Array.from(this.#listeners)) {
        try {
          listener(clone(next), clone(previous));
        } catch (error) {
          console.error("[prefs] change listener threw", error);
        }
      }
    }
    return clone(next);
  }

  #load(): PrefsRow {
    if (this.#row != null) return this.#row;
    const row = defaultRow();
    const provenance = defaultProvenance();
    const stored = this.#read();
    if (stored != null) {
      const storedRow = (stored.row ?? {}) as Record<string, unknown>;
      const storedProvenance = (stored.provenance ?? {}) as Record<
        string,
        unknown
      >;
      for (const leaf of PREFS_LEAVES) {
        const value = getPrefsLeaf(storedRow, leaf);
        if (!validLeaf(leaf, value)) continue;
        setLeaf(row, leaf, value);
        // A leaf's own mark, else its group's (the per-field format).
        const mark =
          storedProvenance[leaf] ?? storedProvenance[leaf.split(".")[0]!];
        if (mark === "legacy" || mark === "user") provenance[leaf] = mark;
      }
      if (typeof storedRow.updatedAt === "string")
        row.updatedAt = storedRow.updatedAt;
    }
    this.#row = row;
    this.#provenance = provenance;
    return row;
  }

  #read(): { row?: unknown; provenance?: unknown } | null {
    if (this.#file == null) return null;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.#file, "utf8"));
      return parsed != null && typeof parsed === "object"
        ? (parsed as { row?: unknown; provenance?: unknown })
        : null;
    } catch {
      // Missing or corrupt: start from defaults; the next write replaces it.
      return null;
    }
  }

  #persist(row: PrefsRow, provenance: PrefsProvenanceMap): void {
    if (this.#file == null) return;
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    writeFileAtomicSync(
      this.#file,
      `${JSON.stringify({ row, provenance }, null, 2)}\n`
    );
  }
}
