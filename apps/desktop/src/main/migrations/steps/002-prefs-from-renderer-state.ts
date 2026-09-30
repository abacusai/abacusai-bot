/**
 * Step 2 (spec 00 C.2, C.4): the old renderer's durable state
 * (`userData/renderer-state.json`) into `~/.abacusai-bot/prefs.json`, by
 * provenance: a field the user set in the new UI is kept, every other mapped
 * field takes the legacy value and is marked `"legacy"`.
 *
 * The write is `create` when `prefs.json` does not exist yet, else
 * `replace-user` (it may hold choices made in the new UI), so the runner
 * backs it up. Nothing is written when the import changes nothing.
 * `renderer-state.json` is only read; the old renderer keeps using it until
 * the cut-over, and the live sync (`installLegacyPrefsSync`) keeps
 * `prefs.json` current after this step.
 */
import fs from "node:fs";
import path from "node:path";

import {
  importLegacyPrefs,
  importLegacySoundOptOut,
} from "../../services/config/legacy-prefs";
import { PrefsStore } from "../../services/config/prefs-store";
import { readRendererStateFile } from "../../services/config/renderer-state";
import { exists } from "../backup";
import type { MigrationStep } from "../types";

export const RENDERER_STATE_FILE_NAME = "renderer-state.json";
export const PREFS_FILE_NAME = "prefs.json";
/** `settings.ts`'s file, for the old renderer's sound opt-out (spec 05 §31.5 i). */
export const CONFIG_FILE_NAME = "config.json";

/** `config.json`'s `notificationSoundDisabled`, or undefined. */
const readSoundOptOut = (file: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed != null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).notificationSoundDisabled
      : undefined;
  } catch {
    return undefined;
  }
};

const readOrNull = (file: string): Buffer | null => {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
};

export interface PrefsStepOptions {
  /** Stamps the row's `updatedAt` when it changes. */
  now?: () => Date;
}

export const prefsFromRendererState = (
  options: PrefsStepOptions = {}
): MigrationStep => ({
  id: 2,
  name: "prefs-from-renderer-state",
  plan: async (ctx) => {
    const source = path.join(ctx.userData, RENDERER_STATE_FILE_NAME);
    const legacy = readRendererStateFile(source);
    const dest = path.join(ctx.home, PREFS_FILE_NAME);
    const staged = path.join(ctx.staging, PREFS_FILE_NAME);

    // The import runs against a staged copy through the one writer of
    // prefs, so the provenance rule is the store's own.
    const current = readOrNull(dest);
    if (current != null) fs.writeFileSync(staged, current);
    const prefs = new PrefsStore({
      file: staged,
      ...(options.now == null ? {} : { now: options.now }),
    });
    const stats = importLegacyPrefs(prefs, (key) => legacy.get(key));
    const sound = importLegacySoundOptOut(
      prefs,
      readSoundOptOut(path.join(ctx.home, CONFIG_FILE_NAME))
    );
    ctx.log(`sound opt-out: ${sound}`);
    ctx.log(
      `${legacy.size} legacy keys, ${stats.keys} mapped: ${JSON.stringify(stats)}`
    );

    const next = readOrNull(staged);
    const changed = next != null && (current == null || !next.equals(current));
    return {
      writes:
        changed && exists(staged)
          ? [
              {
                dest,
                staged,
                kind: current == null ? "create" : "replace-user",
              },
            ]
          : [],
      removals: [],
      stats: { ...stats, written: changed ? 1 : 0 },
    };
  },
});
