/**
 * Durable key-value state for the renderer, owned by the main process. Each
 * renderer is served from its own origin (the version rides the app://
 * hostname), so localStorage resets on every renderer swap; this file in
 * userData does not. Renderer-side face: `renderer/lib/durable-storage.ts`.
 */
import fs from "node:fs";

/**
 * The file's string entries; anything else in it is ignored. A missing or
 * corrupt file reads as empty. A file that exists but cannot be read
 * (EACCES, EBUSY) throws: the prefs migration (spec 00 C.4) must then fail
 * and retry, not record an import of nothing. The store itself still starts
 * empty in that case, as it always has.
 */
export const readRendererStateFile = (file: string): Map<string, string> => {
  const state = new Map<string, string>();

  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return state;
    throw error;
  }

  try {
    const raw = JSON.parse(text) as unknown;

    if (typeof raw === "object" && raw !== null) {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string") state.set(key, value);
      }
    }
  } catch {
    // Missing or corrupt: start empty.
  }

  return state;
};
