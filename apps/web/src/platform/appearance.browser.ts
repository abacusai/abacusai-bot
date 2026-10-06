import { THEME_FILE_MAX_BYTES } from "@abacus-ai/contract/look";

import type { AppClient } from "#renderer/data/transport/types";

/** A browser tab has no window material to show through. */
export const WINDOW_TRANSLUCENCY = false;

/**
 * A theme file from this computer (not the host): a transient file input,
 * read only under the size cap. Resolves null when the picker is dismissed.
 */
export const pickThemeFile = (
  _client: AppClient
): Promise<{ name: string; text: string; size: number } | null> =>
  new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.jsonc,application/json";
    input.addEventListener("cancel", () => resolve(null));
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      // Over the cap the file is not read; the page reports the size.
      if (file.size > THEME_FILE_MAX_BYTES)
        return resolve({ name: file.name, text: "", size: file.size });
      void file.text().then(
        (text) => resolve({ name: file.name, text, size: file.size }),
        () => resolve(null)
      );
    });
    input.click();
  });
