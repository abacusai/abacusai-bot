import type { AppClient } from "#renderer/data/transport/types";

/** The window can be see-through (vibrancy/mica, where the OS has it). */
export const WINDOW_TRANSLUCENCY = true;

/**
 * One theme file through main's open dialog (.json/.jsonc). Over the cap
 * main sends no bytes, only the size; null when cancelled.
 */
export const pickThemeFile = async (
  client: AppClient
): Promise<{ name: string; text: string; size: number } | null> => {
  const file = (await client.system.dialog.openFiles({ kind: "theme" }))?.[0];
  return file
    ? {
        name: file.name,
        text: new TextDecoder().decode(file.data),
        size: file.size ?? file.data.byteLength,
      }
    : null;
};
