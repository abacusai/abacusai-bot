/**
 * Which root a conversation previews a local file under, and the guard in
 * front of `browser.runtime.materializeFile` (spec 04 §12.8). Main picks the
 * root from what it knows of the chat, never from the renderer: the root
 * bounds what a page may load. What it returns are real paths. No Electron.
 */
import fs from "fs/promises";
import path from "path";

import type { PreviewRoot } from "@abacus-ai/contract/contract/browser";

import { openHostFile, resolveHostPath } from "../workspace/host-path";

export const LOCAL_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf",
  "html",
  "htm",
]);

/** What a conversation may preview from, as main derives it. */
export interface PreviewSources {
  /** The chat's own folder (its checkout); relative paths resolve here. */
  chatFolder: string | null;
  /** The folders the user added to the chat. */
  folders: readonly string[];
  /** Files this chat made: each previews under its own folder. */
  made: readonly string[];
  /** Files the user attached: each previews alone, never its folder. */
  attached: readonly string[];
}

export type LocalPreviewCheck =
  | { ok: true; file: string; root: string }
  /** `openHostFile`'s codes, `outside-folders` and `unsupported-type`. */
  | { ok: false; error: string; folder?: string };

const realPath = async (target: string): Promise<string | null> => {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
};

const realAll = async (targets: readonly string[]): Promise<string[]> =>
  (await Promise.all(targets.map(realPath))).filter(
    (entry): entry is string => entry != null
  );

/** The narrowest of `roots` holding `file`, or null. */
const narrowest = (roots: readonly string[], file: string): string | null =>
  roots
    .filter((root) => isInsideRoot(root, file))
    .reduce<string | null>(
      (best, root) => (best == null || root.length > best.length ? root : best),
      null
    );

/**
 * The root for `filePath`: the narrowest chat folder holding it, else the
 * folder of a file this chat made, else the file itself when the user
 * attached it. A path that does not resolve is judged as spelled, so the
 * answer never says whether a file outside the chat exists.
 */
export async function previewRootFor(
  filePath: string,
  sources: PreviewSources
): Promise<PreviewRoot> {
  const base = sources.chatFolder ?? path.dirname(filePath);
  const spelled = path.resolve(base, resolveHostPath(filePath, base));
  const file = (await realPath(spelled)) ?? spelled;
  const folders = await realAll([
    ...(sources.chatFolder == null ? [] : [sources.chatFolder]),
    ...sources.folders,
  ]);
  const made = await realAll(sources.made.map((entry) => path.dirname(entry)));
  const attached = await realAll(sources.attached);
  const root =
    narrowest(folders, file) ??
    narrowest(made, file) ??
    (attached.includes(file) ? file : null);
  return root == null
    ? { ok: false, reason: "outside-folders", folder: path.dirname(file) }
    : { ok: true, root };
}

/** `previewRootFor`, then the readers' containment, a regular file, and a type the view presents. */
export async function checkLocalPreviewFile(
  filePath: string,
  sources: PreviewSources
): Promise<LocalPreviewCheck> {
  const picked = await previewRootFor(filePath, sources);
  if (picked.ok === false)
    return { ok: false, error: picked.reason, folder: picked.folder };
  const base = sources.chatFolder ?? picked.root;
  const opened = await openHostFile(
    path.resolve(base, resolveHostPath(filePath, base)),
    picked.root
  );
  if (opened.ok === false) return { ok: false, error: opened.error };
  const extension = path.extname(opened.realFile).slice(1).toLowerCase();
  if (!LOCAL_PREVIEW_EXTENSIONS.has(extension))
    return { ok: false, error: "unsupported-type" };
  return { ok: true, file: opened.realFile, root: picked.root };
}

/** Whether `candidate` (a real or requested path) lies inside `root`. */
export const isInsideRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};
