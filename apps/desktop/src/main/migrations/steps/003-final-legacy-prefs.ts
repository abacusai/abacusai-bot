/** Release N+1 only. Deliberately absent from MIGRATION_STEPS in N. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { LEGACY_PREFS_KEYS } from "../../services/config/legacy-prefs";
import {
  readRetiredPrefs,
  RETIRED_PREFS_FILE,
} from "../../services/config/retired-prefs";
import { exists, isAbsentError } from "../backup";
import type { MigrationStep } from "../types";
import {
  prefsFromRendererState,
  RENDERER_STATE_FILE_NAME,
} from "./002-prefs-from-renderer-state";

export const finalLegacyPrefs = (): MigrationStep => ({
  id: 3,
  name: "final-legacy-prefs-import-and-drop",
  plan: async (ctx) => {
    if (ctx.attempt == null)
      throw new Error("Migration attempt identity required");
    const plan = await prefsFromRendererState().plan(ctx);
    const dest = path.join(ctx.userData, RENDERER_STATE_FILE_NAME);
    let raw: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(dest, "utf8"));
      if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Invalid renderer state; refusing retirement");
      raw = parsed as Record<string, unknown>;
    } catch (error) {
      if (!isAbsentError(error)) throw error;
      raw = {};
    }
    const retiredDest = path.join(ctx.userData, RETIRED_PREFS_FILE);
    const keys = { ...readRetiredPrefs(retiredDest)?.keys };
    let dropped = 0;
    for (const key of LEGACY_PREFS_KEYS.keys()) {
      if (!Object.hasOwn(raw, key)) continue;
      const value = raw[key];
      keys[key] = createHash("sha256")
        .update(typeof value === "string" ? value : JSON.stringify(value))
        .digest("hex");
      delete raw[key];
      dropped += 1;
    }
    if (dropped > 0) {
      const staged = path.join(ctx.staging, RENDERER_STATE_FILE_NAME);
      fs.writeFileSync(staged, JSON.stringify(raw));
      plan.writes.push({ dest, staged, kind: "replace-user" });
    }
    const staged = path.join(ctx.staging, RETIRED_PREFS_FILE);
    fs.writeFileSync(
      staged,
      JSON.stringify({
        version: 1,
        attempt: ctx.attempt,
        at: new Date().toISOString(),
        keys,
      })
    );
    plan.writes.push({
      dest: retiredDest,
      staged,
      kind: exists(retiredDest) ? "replace-user" : "create",
    });
    return { ...plan, stats: { ...plan.stats, dropped } };
  },
});
