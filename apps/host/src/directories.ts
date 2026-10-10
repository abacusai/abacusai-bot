import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";

import type { DirectoryListing } from "@abacus-ai/contract/contract/files";

import { abacusBotHome, botDefaultWorkspace } from "#main/paths";
import { conflict, forbidden } from "#main/rpc/errors";

const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return part === "" || (!part.startsWith("..") && !isAbsolute(part));
};
const directory = async (path?: string) => {
  if (path === undefined)
    await mkdir(botDefaultWorkspace(), { recursive: true });
  const home = await realpath(homedir());
  const botHome = await realpath(abacusBotHome());
  const root = inside(home, botHome) ? home : botHome;
  const target = await realpath(path ?? botDefaultWorkspace()).catch(() => {
    throw conflict("not-found");
  });
  if (!inside(root, target)) throw forbidden("outside-root");
  if (!(await stat(target)).isDirectory()) throw conflict("not-a-directory");
  return { root, path: target };
};
export const listDirectory = async (
  path?: string
): Promise<DirectoryListing> => {
  const current = await directory(path);
  const entries: DirectoryListing["entries"] = [];
  const children = await readdir(current.path, { withFileTypes: true });
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entries.length >= 400) break;
    const path = join(current.path, child.name);
    try {
      if (!inside(current.root, await realpath(path))) continue;
      const info = await stat(path);
      if (!info.isDirectory() && !info.isFile()) continue;
      entries.push({
        name: child.name,
        path,
        kind: info.isDirectory() ? "directory" : "file",
        sizeBytes: info.size,
      });
    } catch {
      continue;
    }
  }
  return {
    ...current,
    entries: entries.sort(
      (a, b) =>
        Number(b.kind === "directory") - Number(a.kind === "directory") ||
        a.name.localeCompare(b.name)
    ),
  };
};
export const makeDirectory = async (path: string, name: string) => {
  if (!name.trim() || name === "." || name === ".." || /[/\\\0]/.test(name))
    throw forbidden("invalid-name");
  const current = await directory(path);
  const target = join(current.path, name);
  await mkdir(target);
  return { path: target };
};
