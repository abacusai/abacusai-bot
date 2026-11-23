import type {
  SaveCopyItem,
  SaveCopyResult,
} from "@abacus-ai/contract/contract/system";

export const browserPreview = false;
export const previewBlob = async (
  _input: { filePath: string; hostRoot: string },
  _type: string,
  _signal: AbortSignal
): Promise<string> => {
  throw new Error("Browser preview unavailable");
};
export const previewSize = async (
  _input: { filePath: string; hostRoot: string },
  _signal: AbortSignal
): Promise<number> => {
  throw new Error("Browser preview unavailable");
};
// Loaded on first use: a static import is a cycle through the transport's
// own module graph, which stalls the app harness.
const client = async () =>
  (await (await import("#renderer/data/transport")).getTransport()).client;
/** Main asks where (a save dialog, or a folder for several) and copies. */
export const saveFiles = async (
  items: SaveCopyItem[]
): Promise<SaveCopyResult> => (await client()).system.saveCopy({ items });
/** "Show in folder" on where a copy went. */
export const revealSaved = async (path: string): Promise<void> =>
  (await client()).system.showItemInFolder({ path });
