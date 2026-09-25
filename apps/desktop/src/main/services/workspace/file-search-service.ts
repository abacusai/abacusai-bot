import { fileURLToPath, pathToFileURL } from "node:url";

import type { FileFinder } from "@ff-labs/fff-node";

/**
 * The same path, pointing outside app.asar: dlopen knows nothing about the
 * archive and fails with ENOTDIR on it. Unpackaged, returns its argument.
 */
export function asarUnpackedPath(filePath: string): string {
  return filePath.replace(
    /([\\/])app\.asar\1/,
    (_match, separator: string) => `${separator}app.asar.unpacked${separator}`
  );
}

/**
 * The package locates its Rust dylib relative to its own file for ffi-rs to
 * dlopen, so import the unpacked copy (`asarUnpack` in electron-builder.yml).
 */
export function fffEntry(): string {
  const entryPath = fileURLToPath(import.meta.resolve("@ff-labs/fff-node"));
  return pathToFileURL(asarUnpackedPath(entryPath)).href;
}

// Loaded on first search: this pulls in a native addon through ffi-rs, and
// most sessions never open the file picker.
type FffModule = typeof import("@ff-labs/fff-node");
let fffModulePromise: Promise<FffModule> | null = null;
function loadFff(): Promise<FffModule> {
  if (fffModulePromise == null) {
    const loading = (async () => import(fffEntry()))() as Promise<FffModule>;
    // A failed load is not cached: a rejected promise here would fail every
    // search for the rest of the session.
    fffModulePromise = loading;
    void loading.catch(() => {
      if (fffModulePromise === loading) fffModulePromise = null;
    });
  }
  return fffModulePromise;
}

export interface FileSearchItem {
  relativePath: string;
  fileName: string;
  kind: "file" | "directory";
}

export interface FileSearchResult {
  items: FileSearchItem[];
}

const MAX_RESULTS = 20;

// One finder per workspace root: the native index is expensive to build. No
// LRU cap; a user has a handful of workspaces at most.
export class FileSearchService {
  private readonly finders = new Map<string, FileFinder>();
  /** Memoized so two concurrent searches cannot leak one native finder. */
  private readonly finderPromises = new Map<
    string,
    Promise<FileFinder | null>
  >();
  private getFinder(rootPath: string): Promise<FileFinder | null> {
    const pending = this.finderPromises.get(rootPath);
    if (pending != null) return pending;
    const created = this.createFinder(rootPath);
    this.finderPromises.set(rootPath, created);
    // A failed creation is not cached. The next search retries it.
    void created.then((finder) => {
      if (finder == null) this.finderPromises.delete(rootPath);
    });
    return created;
  }

  /**
   * A missing or unloadable dylib becomes `null`, not an unhandled rejection
   * the crash guard would report as an app-level fault.
   */
  private async createFinder(rootPath: string): Promise<FileFinder | null> {
    try {
      return await this.buildFinder(rootPath);
    } catch (error) {
      console.error("[file-search] native file search unavailable", error);
      return null;
    }
  }

  private async buildFinder(rootPath: string): Promise<FileFinder | null> {
    const { FileFinder } = await loadFff();
    const created = FileFinder.create({ basePath: rootPath });
    if (!created.ok) {
      console.error(
        "[file-search] failed to create finder",
        rootPath,
        "error" in created ? created.error : ""
      );
      return null;
    }
    // `waitForScan` resolves to a Result. A finder whose scan timed out would
    // stay cached with an empty index until app restart.
    const scanned = await created.value.waitForScan(10_000);
    if (!scanned.ok || !scanned.value) {
      console.error(
        "[file-search] initial scan did not complete",
        rootPath,
        "error" in scanned ? scanned.error : "timed out"
      );
      created.value.destroy();
      return null;
    }
    this.finders.set(rootPath, created.value);
    return created.value;
  }

  async search(rootPath: string, query: string): Promise<FileSearchResult> {
    const finder = await this.getFinder(rootPath);
    if (finder == null) return { items: [] };

    const trimmed = query.trim();
    const res = finder.mixedSearch(trimmed, { pageSize: MAX_RESULTS });
    if (!res.ok) {
      console.error(
        "[file-search] search failed",
        trimmed,
        "error" in res ? res.error : ""
      );
      return { items: [] };
    }

    const items: FileSearchItem[] = res.value.items
      .map((mi) => {
        const rel = mi.item.relativePath;
        const name = mi.type === "file" ? mi.item.fileName : mi.item.dirName;
        const relativePath = (rel ?? name ?? "")
          .replaceAll("\\", "/")
          .replace(/\/+$/, "");
        const fileName = (name ?? rel ?? "").replace(/[\\/]+$/, "");
        return {
          relativePath,
          fileName,
          kind:
            mi.type === "directory"
              ? ("directory" as const)
              : ("file" as const),
        };
      })
      .filter((i) => i.relativePath.length > 0);

    return { items };
  }

  dispose(): void {
    for (const finder of this.finders.values()) {
      try {
        finder.destroy();
      } catch {
        /* already gone */
      }
    }
    this.finders.clear();
    this.finderPromises.clear();
  }
}
