import fs from "node:fs";

import * as v from "valibot";

export const RETIRED_PREFS_FILE = "renderer-state.retired.json";
export const RetiredPrefsSchema = v.strictObject({
  version: v.literal(1),
  attempt: v.string(),
  at: v.string(),
  keys: v.record(v.string(), v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/))),
});
export type RetiredPrefs = v.InferOutput<typeof RetiredPrefsSchema>;

/** An unreadable retirement record cannot authorize resetting preferences. */
export const readRetiredPrefs = (file: string): RetiredPrefs | null => {
  try {
    return v.parse(
      RetiredPrefsSchema,
      JSON.parse(fs.readFileSync(file, "utf8"))
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};
