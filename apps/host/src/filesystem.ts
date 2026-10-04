import { randomUUID } from "node:crypto";
import { mkdir, rename, cp, rm, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
export const trashItem = async (file: string): Promise<void> => {
  const home =
    process.env.ABACUSAI_BOT_HOME || join(homedir(), ".abacusai-bot");
  const dir = join(home, "trash", new Date().toISOString().slice(0, 10));
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

export const sweepTrash = async (home: string) => {
  const root = join(home, "trash");
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const file = join(root, name);
    if ((await stat(file)).mtimeMs < Date.now() - 30 * 86400_000)
      await rm(file, { recursive: true, force: true });
  }
};
