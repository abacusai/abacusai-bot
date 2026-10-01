import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const executableScripts = (repo, workspace) => {
  const result = new Set();
  const scan = (source, directory) => {
    for (const match of source.matchAll(
      /(?:node\s+|["']|beforePack:\s*)(scripts\/[\w./-]+\.(?:js|mjs|cjs))/g
    )) {
      const file = path.resolve(directory, match[1]);
      if (file.startsWith(workspace + path.sep))
        result.add(path.relative(workspace, file));
    }
  };
  for (const directory of [repo, workspace])
    scan(
      fs.readFileSync(path.join(directory, "package.json"), "utf8"),
      directory
    );
  scan(
    fs.readFileSync(path.join(workspace, "electron-builder.yml"), "utf8"),
    workspace
  );
  for (const file of fs.readdirSync(path.join(repo, ".github/workflows")))
    scan(
      fs.readFileSync(path.join(repo, ".github/workflows", file), "utf8"),
      workspace
    );
  scan(fs.readFileSync(path.join(repo, "turbo.json"), "utf8"), workspace);
  return [...result].sort();
};
export const checkEntries = (actual, expected) => {
  const scripts = actual.filter((entry) => entry.startsWith("scripts/")).sort();
  if (JSON.stringify(scripts) !== JSON.stringify(expected))
    throw new Error(
      `Executable knip entries differ: ${JSON.stringify({ scripts, expected })}`
    );
};
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repo = process.cwd(),
    workspace = path.join(repo, "apps/desktop");
  checkEntries(
    JSON.parse(fs.readFileSync("knip.json")).workspaces["apps/desktop"].entry,
    executableScripts(repo, workspace)
  );
  console.log("Executable knip entries pass.");
}
