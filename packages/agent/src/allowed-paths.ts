/**
 * Directories the host pre-allows outside the workspace. A routine's run gets
 * its own state folder this way; the containment gate would otherwise ask about
 * every write there with nobody at the keyboard. The rest of home still asks.
 */
import * as path from "node:path";

export const ALLOWED_PATHS_ENV = "ABACUSAI_BOT_ALLOWED_PATHS";

/** Absolute directories, `path.delimiter`-separated; blanks and relatives dropped. */
export const allowedPathsFromEnv = (
  env: NodeJS.ProcessEnv = process.env
): string[] => {
  const raw = env[ALLOWED_PATHS_ENV] ?? "";
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry))
    .map((entry) => path.resolve(entry));
};
