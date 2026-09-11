/**
 * Where a relative output path from the model actually lands. The tools
 * promise "relative to the workspace", and only the agent knows it: the
 * desktop host would resolve against its own cwd, `/` in a packaged app.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Absolute, workspace-relative, or `~/…` — all resolved the same way. */
export function resolveInWorkspace(rawPath: string, cwd: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.startsWith("~/") || trimmed === "~") {
    return path.join(os.homedir(), trimmed.slice(1));
  }
  return path.resolve(cwd, trimmed);
}

/**
 * Whether a path really lands inside a directory, symlinks included.
 *
 * `path.resolve` does not follow links, so a workspace link to `/etc/hosts`
 * would pass as a workspace file; only the real path says where the bytes
 * come from. Both sides are resolved because the workspace itself is often
 * reached through a link (`/tmp` is `/private/tmp` on macOS).
 */
export function isInsideDirectory(
  candidate: string,
  directory: string
): boolean {
  const root = realPathOf(path.resolve(directory));
  const real = realPathOf(candidate);
  // Unresolvable means not known to be inside anything: fail closed.
  if (root === null || real === null) return false;

  const relative = path.relative(root, real);

  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * The real path of something that may not exist yet: the nearest existing
 * ancestor is resolved and the remainder re-attached. A DANGLING link is
 * followed by hand first, since writing it creates its TARGET, possibly
 * outside the workspace. Hardlinks are invisible and judged as given.
 * Returns null on a link loop; callers must fail closed, because the only
 * other answer is the lexical path that following exists to distrust.
 */
export function realPathOf(target: string): string | null {
  return followPath(path.resolve(target), LINK_BUDGET);
}

/** Enough for any sane chain; past it, the path is a loop. */
const LINK_BUDGET = 40;

function followPath(target: string, linkBudget: number): string | null {
  const missing: string[] = [];
  let head = target;

  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...missing);
    } catch {
      let link: string | undefined;
      try {
        if (fs.lstatSync(head).isSymbolicLink()) {
          link = fs.readlinkSync(head);
        }
      } catch {
        // Truly absent, not a dangling link: keep walking up.
      }
      if (link != null) {
        if (linkBudget <= 0) return null;
        // A relative link aims from the directory it really sits in.
        const parent = followPath(path.dirname(head), linkBudget);
        if (parent === null) return null;
        const resolved = followPath(path.resolve(parent, link), linkBudget - 1);

        return resolved === null ? null : path.join(resolved, ...missing);
      }

      const parent = path.dirname(head);
      // Nothing on the path exists: the lexical path is the best answer.
      if (parent === head) return path.join(head, ...missing);
      missing.unshift(path.basename(head));
      head = parent;
    }
  }
}
