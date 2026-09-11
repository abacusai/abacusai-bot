import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Canonical experience manifest builder. The desktop verifier recomputes every
 * digest from the same canon: sorted keys, compact separators, ASCII paths.
 */

export const FOUNDATION_API = 1;
export const PROTOCOL = "abacus.desktop/1";

export interface FileEntry {
  readonly sha256: string;
  readonly size: number;
}

const compareNames = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

export const listFiles = async (root: string): Promise<string[]> => {
  const collect = async (directory: string): Promise<string[]> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error(`Experience source contains a link: ${absolute}`);
        }
        if (entry.isDirectory()) {
          return await collect(absolute);
        }
        return entry.isFile()
          ? [path.relative(root, absolute).split(path.sep).join("/")]
          : [];
      })
    );
    return nested.flat();
  };
  const files = await collect(root);
  return files.toSorted(compareNames);
};

const sortedEntries = (
  files: Record<string, FileEntry>
): Record<string, FileEntry> =>
  Object.fromEntries(
    Object.entries(files)
      .toSorted(([left], [right]) => compareNames(left, right))
      .map(([name, entry]) => [
        name,
        { sha256: entry.sha256, size: entry.size },
      ])
  );

const identity = (files: Record<string, FileEntry>, prefix: string): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(files)
            .filter(([name]) => name.startsWith(prefix))
            .map(([name, entry]) => [name.slice(prefix.length), entry])
        )
      )
    )
    .digest("hex");

export const buildManifest = async (
  root: string,
  foundation: string
): Promise<string> => {
  const files: Record<string, FileEntry> = {};
  for (const relative of await listFiles(root)) {
    if (!/^[\u0020-\u007E]+$/u.test(relative)) {
      throw new Error(`Experience path is not ASCII: ${relative}`);
    }
    const data = await fs.readFile(path.join(root, relative));
    files[relative] = {
      sha256: createHash("sha256").update(data).digest("hex"),
      size: data.byteLength,
    };
  }
  const sorted = sortedEntries(files);
  // Inside the identity, so the same tree built for another release gets a
  // different experienceVersion.
  const experienceIdentity = JSON.stringify({
    files: sorted,
    foundation,
    foundationApi: FOUNDATION_API,
    protocol: PROTOCOL,
  });
  return JSON.stringify({
    agentVersion: identity(sorted, "agent/"),
    experienceVersion: createHash("sha256")
      .update(experienceIdentity)
      .digest("hex"),
    files: sorted,
    foundation,
    foundationApi: FOUNDATION_API,
    protocol: PROTOCOL,
    rendererVersion: identity(sorted, "renderer/"),
  });
};
