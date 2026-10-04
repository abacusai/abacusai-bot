import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
export const trashItem = async (file: string): Promise<void> => {
  const home =
    process.env.ABACUSAI_BOT_HOME || join(homedir(), ".abacusai-bot");
  const dir = join(home, "trash", new Date().toISOString().slice(0, 10));
  await mkdir(dir, { recursive: true });
  await rename(file, join(dir, `${randomUUID()}-${basename(file)}`));
};
