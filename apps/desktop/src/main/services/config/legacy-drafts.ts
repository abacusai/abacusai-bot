import fs from "node:fs";
import path from "node:path";

import { nodeIo, writeFileAtomic } from "../../migrations/backup";
import { readRendererStateFile } from "./renderer-state";

const receiptFile = (home: string) =>
  path.join(home, "electron", "composer-drafts.imported.json");
const receipts = (home: string): string[] => {
  try {
    const keys: unknown = JSON.parse(
      fs.readFileSync(receiptFile(home), "utf8")
    );
    if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string"))
      throw new Error("Invalid draft import receipts");
    return keys;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

export const pendingLegacyDrafts = (home: string): Record<string, string> => {
  const imported = new Set(receipts(home));
  return Object.fromEntries(
    [
      ...readRendererStateFile(
        path.join(home, "electron", "renderer-state.json")
      ),
    ]
      .filter(
        ([key]) =>
          key.startsWith("composer.draft:") &&
          key.length > "composer.draft:".length
      )
      .map(([key, text]) => [key.slice("composer.draft:".length), text])
      .filter(([key]) => !imported.has(key!))
  );
};

/** Called after the renderer has persisted the imported text. Keep the source for recovery. */
export const acknowledgeLegacyDrafts = (home: string, keys: string[]): void => {
  fs.mkdirSync(path.dirname(receiptFile(home)), { recursive: true });
  writeFileAtomic(
    receiptFile(home),
    JSON.stringify([...new Set([...receipts(home), ...keys])]),
    nodeIo
  );
};
