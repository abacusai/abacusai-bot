/**
 * The guard in front of `browser.runtime.materializeFile` (spec 04 §12.8):
 * the same containment as `files.readText` (symlinks resolved first; guest
 * and `~` paths as the readers resolve them), a regular file, and a type the
 * local-file view presents. What it returns are real paths, so the view's own
 * request filter compares like with like. No Electron.
 */
import fs from "fs/promises";
import path from "path";

import { openHostFile, resolveHostPath } from "../workspace/host-path";

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
 * the folders of the files the bot made). The file must lie inside one of
 * them; the view's root, which bounds what the page can load, is the
 * caller's `hostRoot` when that is inside an allowed root and holds the file,
 * else the narrowest allowed root that holds it. So a page the bot saved to
 * the Desktop opens from a chat whose `hostRoot` is the checkout.
 */
export async function checkLocalPreviewFile(
  filePath: string,
  hostRoot: string,
  allowedRoots: readonly string[]
): Promise<LocalPreviewCheck> {
  const allowed: string[] = [];
  for (const root of allowedRoots) {
    const real = await realPath(root);
    if (real != null) allowed.push(real);
  }
  const requested = await realPath(hostRoot);
  const requestedAllowed =
    requested != null && allowed.some((root) => isInsideRoot(root, requested));
  const candidates = [
    ...(requestedAllowed ? [requested] : []),
    ...allowed.toSorted((left, right) => right.length - left.length),
  ];
  const target = resolveHostPath(filePath, hostRoot);
  for (const root of candidates) {
    const opened = await openHostFile(target, root);
    if (opened.ok === false && opened.error === "outside-root") continue;
    // Under a root main did not give, a missing file says nothing more.
    if (opened.ok === false && !requestedAllowed) break;
    if (opened.ok === false) return { ok: false, error: opened.error };
    const extension = path.extname(opened.realFile).slice(1).toLowerCase();
    if (!LOCAL_PREVIEW_EXTENSIONS.has(extension))
      return { ok: false, error: "unsupported-type" };
    return { ok: true, file: opened.realFile, root };
  }
  return {
    ok: false,
    error: requestedAllowed ? "outside-root" : "root-not-allowed",
  };
}

/** Whether `candidate` (a real or requested path) lies inside `root`. */
export const isInsideRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};
