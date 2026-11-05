/**
 * The project as it stood before this turn, rebuilt in a scratch directory so
 * its tests can run without touching the user's tree. The turn's own writes
 * are the only difference that matters, so the file tools' pre-images are laid
 * over a copy of the tree as it is now. Whatever can't be rebuilt (a command
 * changed a file, a dependency lives above the project) makes a test fail here
 * too, and that reads as "already failing": the error is always towards leaving
 * tests alone.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Dependencies are linked, not copied: too big to copy, and only ever read. */
const LINKED_DIRS = new Set(["node_modules", ".venv", "venv"]);
/** Build output and caches: a run makes its own. */
const SKIPPED_DIRS = new Set([
  ".git",
  ".gradle",
  ".next",
  ".nuxt",
  ".pytest_cache",
  ".ruff_cache",
  ".mypy_cache",
  ".tox",
  ".turbo",
  ".cache",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "target",
]);
/** Past these the copy costs more than the answer is worth. */
const MAX_COPIED_FILES = 20_000;
const MAX_COPIED_BYTES = 500 * 1024 * 1024;
/** What a turn's pre-images may hold in memory. */
const MAX_PRE_IMAGE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PRE_IMAGE_BYTES = 32 * 1024 * 1024;

/** Each file the turn wrote as it was before the first write; null: it was new. */
export class PreImages {
  private readonly files = new Map<string, Buffer | null>();
  private bytes = 0;
  private complete = true;

  /** Call before a write lands. Only the first write of a file counts. */
  note(file: string): void {
    if (this.files.has(file)) return;

    try {
      const size = fs.statSync(file).size;

      this.bytes += size;
      if (size > MAX_PRE_IMAGE_FILE_BYTES || this.bytes > MAX_PRE_IMAGE_BYTES) {
        this.complete = false;

        return;
      }
      this.files.set(file, fs.readFileSync(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        this.files.set(file, null);
      else this.complete = false;
    }
  }

  /** A write landed that the turn's pre-images can't undo. */
  lose(): void {
    this.complete = false;
  }

  clear(): void {
    this.files.clear();
    this.bytes = 0;
    this.complete = true;
  }

  get intact(): boolean {
    return this.complete;
  }

  entries(): IterableIterator<[string, Buffer | null]> {
    return this.files.entries();
  }
}

/** Copies `from` into `to`, or returns false when it is too large to. */
async function copyTree(from: string, to: string): Promise<boolean> {
  let files = 0;
  let bytes = 0;
  const walk = async (source: string, target: string): Promise<boolean> => {
    await fs.promises.mkdir(target, { recursive: true });

    for (const entry of await fs.promises.readdir(source, {
      withFileTypes: true,
    })) {
      const from = path.join(source, entry.name);
      const to = path.join(target, entry.name);

      if (entry.isSymbolicLink()) {
        await fs.promises.symlink(await fs.promises.readlink(from), to);
      } else if (entry.isDirectory()) {
        if (LINKED_DIRS.has(entry.name))
          await fs.promises.symlink(from, to, "junction");
        else if (!SKIPPED_DIRS.has(entry.name) && !(await walk(from, to)))
          return false;
      } else if (entry.isFile()) {
        files += 1;
        bytes += (await fs.promises.stat(from)).size;
        if (files > MAX_COPIED_FILES || bytes > MAX_COPIED_BYTES) return false;
        await fs.promises.copyFile(from, to, fs.constants.COPYFILE_FICLONE);
      }
    }

    return true;
  };

  return walk(from, to);
}

/** Puts the turn's files in `tree` back as they were. */
async function undoWrites(
  cwd: string,
  tree: string,
  preImages: PreImages
): Promise<void> {
  for (const [file, content] of preImages.entries()) {
    const relative = path.relative(cwd, file);

    // Outside the project: not part of what its tests see from here.
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const target = path.join(tree, relative);

    if (content == null) await fs.promises.rm(target, { force: true });
    else {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, content);
    }
  }
}

/**
 * Runs `use` in a scratch copy of the project as it stood before the turn, and
 * removes the copy. Null when the copy can't be made.
 */
export async function inPreTurnTree<T>(
  cwd: string,
  preImages: PreImages,
  use: (tree: string) => Promise<T>
): Promise<T | null> {
  if (!preImages.intact) return null;
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "abacusai-bot-baseline-")
  );
  // The directory's own name, since a project's tests may read it.
  const tree = path.join(root, path.basename(path.resolve(cwd)));

  try {
    if (!(await copyTree(cwd, tree))) return null;
    await undoWrites(cwd, tree, preImages);

    return await use(tree);
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}
