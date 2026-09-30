/**
 * The new renderer's preferences (spec 00 B.2): one row, `"app"`, in
 * `~/.abacusai-bot/prefs.json`, written atomically. Main owns it; the renderer
 * reads it as the `db.prefs` table and writes it through `db.prefs.update`.
 *
 * The file is `{ row, provenance }`. Provenance says who last set each field:
 * `"default"` (never written), `"legacy"` (imported from the old renderer's
 * durable state) or `"user"` (chosen in the new UI). A legacy import never
 * overwrites a `"user"` field, so an explicit choice survives even when it
 * equals the default. Provenance never reaches the renderer.
 *
 * `update` and `importLegacy` are the only writers, and so the only places
 * provenance is set.
 */
import fs from "fs";
import path from "path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";
import * as v from "valibot";

import { AgentMode } from "#shared/agent-types";
import { PrefsPatchSchema } from "#shared/contract/db";
import type { PrefsField, PrefsPatch, PrefsRow } from "#shared/contract/rows";

import { abacusBotHome } from "../../paths";

export type PrefsProvenance = "default" | "legacy" | "user";

export type PrefsProvenanceMap = Record<PrefsField, PrefsProvenance>;

type PrefsValues = Omit<PrefsRow, "id" | "updatedAt">;

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
  sounds: { enabled: true, perEvent: {} },
};

/** What a field is before anyone sets it. Mirrors the old renderer's defaults. */
export const PREFS_DEFAULTS: Readonly<PrefsValues> = Object.freeze(DEFAULTS);

export const PREFS_FIELDS = Object.keys(PREFS_DEFAULTS) as PrefsField[];

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
    PREFS_FIELDS.map((field) => [field, "default"])
  ) as PrefsProvenanceMap;

const FIELD_SCHEMAS = PrefsPatchSchema.entries;

/** A stored field that no longer validates falls back to its default. */
const validField = (field: PrefsField, value: unknown): boolean =>
  value !== undefined && v.safeParse(FIELD_SCHEMAS[field], value).success;

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

  provenance(): PrefsProvenanceMap {
    this.#load();
    return { ...this.#provenance };
  }

  /**
   * The new UI's write: the touched fields become `"user"`, even when the
   * value equals what is stored (an explicit choice).
   */
  update(patch: PrefsPatch): PrefsRow {
    const parsed = v.parse(PrefsPatchSchema, patch) as PrefsPatch;
    return this.#apply(parsed, () => "user");
  }

  /**
   * The old renderer's value for some fields (spec 00 C.4). A field the user
   * set in the new UI is left alone; every other field it names takes the
   * value and becomes `"legacy"`. Invalid fields are skipped, never the row.
   */
  importLegacy(patch: PrefsPatch): { row: PrefsRow; invalid: number } {
    this.#load();
    let invalid = 0;
    const accepted: PrefsPatch = {};
    for (const [field, value] of Object.entries(patch) as [
      PrefsField,
      unknown,
    ][]) {
      if (!PREFS_FIELDS.includes(field)) continue;
      if (!validField(field, value)) {
        invalid += 1;
        continue;
      }
      if (this.#provenance[field] === "user") continue;
      (accepted as Record<string, unknown>)[field] = value;
    }
    return { row: this.#apply(accepted, () => "legacy"), invalid };
  }

  /** Called after every write that changed the row. */
  onChanged(listener: PrefsChangeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #apply(
    patch: PrefsPatch,
    provenanceFor: (field: PrefsField) => PrefsProvenance
  ): PrefsRow {
    const previous = this.#load();
    const next: PrefsRow = clone(previous);
    let rowChanged = false;
    let provenanceChanged = false;
    for (const [field, value] of Object.entries(patch) as [
      PrefsField,
      unknown,
    ][]) {
      if (value === undefined) continue;
      if (!same(next[field], value)) {
        (next as unknown as Record<string, unknown>)[field] = clone(value);
        rowChanged = true;
      }
      const provenance = provenanceFor(field);
      if (this.#provenance[field] !== provenance) {
        this.#provenance[field] = provenance;
        provenanceChanged = true;
      }
    }
    if (!rowChanged && !provenanceChanged) return clone(previous);
    if (rowChanged) next.updatedAt = this.#now().toISOString();
    this.#row = next;
    this.#persist();
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
      for (const field of PREFS_FIELDS) {
        if (!validField(field, storedRow[field])) continue;
        (row as unknown as Record<string, unknown>)[field] = storedRow[field];
        const mark = storedProvenance[field];
        if (mark === "legacy" || mark === "user") provenance[field] = mark;
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

  #persist(): void {
    if (this.#file == null || this.#row == null) return;
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    writeFileAtomicSync(
      this.#file,
      `${JSON.stringify({ row: this.#row, provenance: this.#provenance }, null, 2)}\n`
    );
  }
}
