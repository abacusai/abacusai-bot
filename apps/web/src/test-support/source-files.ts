/** Source inventories read text; they must not count every source as a module import in knip. */
import fs from "node:fs";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "../../..");
export const readSourceFiles = (
  patterns: string | string[],
  from: string
): Record<string, string> => {
  const globs = typeof patterns === "string" ? [patterns] : patterns;
  const absolute = globs.some((pattern) => pattern.startsWith("/"));
  const cwd = absolute ? desktop : from;
  const normalize = (pattern: string) =>
    absolute ? pattern.replace(/^\//, "") : pattern;
  const include = globs
    .filter((pattern) => !pattern.startsWith("!"))
    .map(normalize);
  const exclude = globs
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => normalize(pattern.slice(1)));
  return Object.fromEntries(
    fs.globSync(include, { cwd, exclude }).map((file) => {
      const key = absolute
        ? `/${file}`
        : file.startsWith("..")
          ? file
          : `./${file}`;
      return [
        key.replaceAll(path.sep, "/"),
        fs.readFileSync(path.join(cwd, file), "utf8"),
      ];
    })
  );
};
