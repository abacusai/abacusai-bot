/**
 * A chat's added folders, at the door: what a path names once checked (a
 * real folder the sandbox may be handed), and which paths a user message
 * attached. The list itself lives on the session record.
 */
import fs from "fs/promises";
import path from "path";

import { workspaceFolderRefusal } from "@abacus-ai/agent/workspace-folders";

export type ResolvedFolder =
  | { ok: true; folder: string }
  | { ok: false; error: "not-a-folder" | "folder-not-allowed" };

/** The real folder `input` names, if it may join a chat's folders. */
export async function resolveSessionFolder(
  input: string,
  home?: string
): Promise<ResolvedFolder> {
  if (!path.isAbsolute(input)) return { ok: false, error: "not-a-folder" };
  let folder: string;
  try {
    folder = await fs.realpath(input);
    if (!(await fs.stat(folder)).isDirectory())
      return { ok: false, error: "not-a-folder" };
  } catch {
    return { ok: false, error: "not-a-folder" };
  }
  const refused = workspaceFolderRefusal(folder, home);
  return refused == null ? { ok: true, folder } : { ok: false, error: refused };
}

/**
 * The absolute paths a user message attached: the composer sends each as an
 * `@<path>` line of its own (Windows paths with forward slashes).
 */
export const attachedPathsOf = (text: string): string[] => [
  ...new Set(
    text
      .split(/\r?\n/)
      .map((line) => /^@(.+)$/.exec(line.trim())?.[1]?.trim() ?? "")
      .filter(
        (entry) => path.isAbsolute(entry) || /^[A-Za-z]:[\\/]/.test(entry)
      )
  ),
];

/** What one attached path is: a folder, a file, or nothing usable. */
export async function attachedKind(
  target: string
): Promise<{ kind: "folder" | "file"; real: string } | null> {
  try {
    const real = await fs.realpath(target);
    const stat = await fs.stat(real);
    if (stat.isDirectory()) return { kind: "folder", real };
    return stat.isFile() ? { kind: "file", real } : null;
  } catch {
    return null;
  }
}
