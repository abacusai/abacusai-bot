#!/usr/bin/env node
/**
 * The registry snapshot and its check (spec 01 §5.4).
 *
 *   node scripts/shadcn-registry-snapshot.mjs --record
 *     Dry-runs the §5.2 `add` through the proxy in record mode, storing every
 *     response under shadcn-registry/<today>/ with a manifest. (Run
 *     shadcn-init.mjs --snapshot <same dir> first, so init's fetches are
 *     in it too.) Commit the directory on its own.
 *
 *   node scripts/shadcn-registry-snapshot.mjs --check        (check:ui-registry)
 *     Offline. Copies this package's registry inputs to a temp dir, replays
 *     the `add` from the newest snapshot there, formats the output with the
 *     repo's oxfmt config and diffs it against the committed ui/.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registryContent } from "./registry-content.mjs";
import { addFromSnapshot, INITIAL_ITEMS, latestSnapshot } from "./shadcn.mjs";

const desktop = join(import.meta.dirname, "..");
const repo = join(desktop, "../..");

const record = async () => {
  const snapshot = join(
    desktop,
    "shadcn-registry",
    new Date().toISOString().slice(0, 10)
  );
  await addFromSnapshot({
    items: INITIAL_ITEMS,
    snapshot,
    record: true,
    dryRun: true,
  });
  console.log(`recorded ${snapshot}`);
};

const check = async () => {
  const temp = mkdtempSync(join(tmpdir(), "ui-registry-"));
  try {
    for (const file of ["package.json", "components.json", "tsconfig.json"])
      cpSync(join(desktop, file), join(temp, file));
    mkdirSync(join(temp, "src/renderer"), { recursive: true });
    for (const dir of ["styles", "lib"])
      cpSync(
        join(desktop, "src/renderer", dir),
        join(temp, "src/renderer", dir),
        {
          recursive: true,
        }
      );
    // The CLI resolves packages from node_modules next to package.json.
    execFileSync("ln", [
      "-s",
      join(repo, "node_modules"),
      join(temp, "node_modules"),
    ]);

    await addFromSnapshot({
      cwd: temp,
      items: INITIAL_ITEMS,
      snapshot: latestSnapshot(),
    });
    execFileSync(
      join(repo, "node_modules/.bin/oxfmt"),
      [
        "--config",
        join(repo, "oxfmt.config.ts"),
        join(temp, "src/renderer/ui"),
      ],
      {
        cwd: repo,
        stdio: "inherit",
      }
    );

    const committed = join(desktop, "src/renderer/ui");
    const replayed = join(temp, "src/renderer/ui");
    const names = new Set([
      ...readdirSync(committed),
      ...readdirSync(replayed),
    ]);
    const { rsc } = JSON.parse(
      readFileSync(join(desktop, "components.json"), "utf8")
    );
    const diffs = [...names].filter((name) => {
      try {
        return (
          registryContent(readFileSync(join(committed, name), "utf8"), rsc) !==
          registryContent(readFileSync(join(replayed, name), "utf8"), rsc)
        );
      } catch {
        return true;
      }
    });
    if (diffs.length > 0) {
      console.error(
        `check:ui-registry: ui/ differs from the snapshot: ${diffs.join(", ")}`
      );
      process.exit(1);
    }
    console.log(`check:ui-registry: ${names.size} files match the snapshot`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
};

const mode = process.argv[2];
if (mode === "--record") await record();
else if (mode === "--check") await check();
else {
  console.error("usage: shadcn-registry-snapshot.mjs --record | --check");
  process.exit(1);
}
