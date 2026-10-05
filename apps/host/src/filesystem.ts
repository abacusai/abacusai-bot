import { randomUUID } from "node:crypto";
import { mkdir, rename, cp, rm, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";

import { abacusBotHome } from "#main/paths";

/** Moves into a dated trash under the bot home; a sweep removes month-old days. */
export const trashItem = async (file: string): Promise<void> => {
  const dir = join(
    abacusBotHome(),
    "trash",
    new Date().toISOString().slice(0, 10)
  );
  await mkdir(dir, { recursive: true });
  const destination = join(dir, `${randomUUID()}-${basename(file)}`);
  try {
    await rename(file, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    try {
      await cp(file, destination, {
        recursive: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
      });
    } catch (copyError) {
      await rm(destination, { recursive: true, force: true });
      throw copyError;
    }
    await rm(file, { recursive: true });
  }
};

export const sweepTrash = async () => {
  const root = join(abacusBotHome(), "trash");
  try {
    for (const name of await readdir(root)) {
      const file = join(root, name);
      try {
        if ((await stat(file)).mtimeMs < Date.now() - 30 * 86400_000)
          await rm(file, { recursive: true, force: true });
      } catch (error) {
        console.warn("[host-trash] sweep entry failed", file, error);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn("[host-trash] sweep failed", root, error);
  }
};
