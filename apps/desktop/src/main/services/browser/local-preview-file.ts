/**
 * The guard in front of `browser.runtime.materializeFile` (spec 04 §12.8):
 * the same containment as `files.readText` (`filePath` inside `hostRoot`,
 * symlinks resolved first; guest and `~` paths as the readers resolve
 * them), a regular file, and a type the local-file view presents. What it
 * returns are real paths, so the view's own request filter compares like
 * with like. No Electron.
 */
import fs from "fs/promises";
import path from "path";

import { openHostFile } from "../workspace/host-path";

export const LOCAL_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf",
  "html",
  "htm",
]);

export type LocalPreviewCheck =
  | { ok: true; file: string; root: string }
  /** `openHostFile`'s codes, `root-not-allowed` and `unsupported-type`. */
  | { ok: false; error: string };

const realPath = async (target: string): Promise<string | null> => {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
};

/**
 * `allowedRoots` are main's own answer for the conversation (its checkout,
 * its artifact folders): the caller's `hostRoot` must be one of them or lie
 * inside one, compared as real paths, or it is `root-not-allowed`.
 */
export async function checkLocalPreviewFile(
  filePath: string,
  hostRoot: string,
  allowedRoots: readonly string[]
): Promise<LocalPreviewCheck> {
  const requested = await realPath(hostRoot);
  if (requested == null) return { ok: false, error: "root-not-allowed" };
  let allowed = false;
  for (const root of allowedRoots) {
    const real = await realPath(root);
    if (real != null && isInsideRoot(real, requested)) {
      allowed = true;
      break;
    }
  }
  if (!allowed) return { ok: false, error: "root-not-allowed" };
  const opened = await openHostFile(filePath, hostRoot);
  if (opened.ok === false) return { ok: false, error: opened.error };
  const extension = path.extname(opened.realFile).slice(1).toLowerCase();
  if (!LOCAL_PREVIEW_EXTENSIONS.has(extension))
    return { ok: false, error: "unsupported-type" };
  return { ok: true, file: opened.realFile, root: await fs.realpath(hostRoot) };
}

/** Whether `candidate` (a real or requested path) lies inside `root`. */
export const isInsideRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};
