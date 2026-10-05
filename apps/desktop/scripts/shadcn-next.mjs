#!/usr/bin/env node
/**
 * The only way `shadcn add` runs in this package (spec 01 §5.1 step 4, §5.4):
 *
 *   node scripts/shadcn-next.mjs add <items…> [--record]
 *
 * 1. `shadcn add <items> --dry-run` against the local registry proxy (replay
 *    of the committed snapshot; `--record` fetches upstream and records a new
 *    snapshot instead). Its planned file list must stay under
 *    src/renderer-next/{ui,lib,components} and its planned dependencies inside
 *    the measured registry set (§3.1).
 * 2. Only then the real `add`, replayed from the snapshot (offline).
 * 3. `shadcn info --json` must resolve ui/css/icons to renderer-next, and
 *    src/renderer must be untouched.
 *
 * Also exports `addFromSnapshot()` for check:ui-registry.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  REGISTRY_DEPENDENCIES,
  REQUIRED_CSS_LINES,
  SHADCN_VERSION,
} from "./shadcn-next-init.mjs";
import { run, startRegistryProxy } from "./shadcn-registry-proxy.mjs";

const desktop = join(import.meta.dirname, "..");
export const shadcnBin = join(desktop, "../../node_modules/.bin/shadcn");

/** The committed snapshot: the newest dated directory. */
export const latestSnapshot = (root = join(desktop, "shadcn-registry")) => {
  const dates = readdirSync(root)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort();
  const latest = dates.at(-1);
  if (latest == null) throw new Error(`no snapshot under ${root}`);
  return join(root, latest);
};

/** §5.2, in this order so dependencies resolve once. */
export const INITIAL_ITEMS = [
  "button",
  "dialog",
  "alert-dialog",
  "sheet",
  "drawer",
  "tabs",
  "dropdown-menu",
  "context-menu",
  "popover",
  "tooltip",
  "hover-card",
  "combobox",
  "command",
  "resizable",
  "scroll-area",
  "kbd",
  "field",
  "label",
  "input",
  "input-group",
  "textarea",
  "item",
  "empty",
  "spinner",
  "skeleton",
  "separator",
  "badge",
  "avatar",
  "toggle",
  "toggle-group",
  "switch",
  "select",
  "native-select",
  "toast",
  "message-scroller",
  "message",
  "bubble",
  "attachment",
  "marker",
  "questionnaire",
  "collapsible",
];

const ALLOWED_DIRS = [
  "src/renderer-next/ui/",
  "src/renderer-next/lib/",
  "src/renderer-next/components/",
];

const fail = (message) => {
  console.error(`shadcn-next: ${message}`);
  process.exit(1);
};

/**
 * The paths and packages a dry run plans. shadcn 4.21 prints a tree:
 * `├ Files (n)` then `│ + <path>  create|update`, and `├ Dependencies (n)`
 * then `│ + <name>`. Any other section header ends the current one.
 */
export const parseDryRun = (output) => {
  const files = [];
  const dependencies = [];
  let section = null;
  for (const raw of output.split("\n")) {
    const line = stripVTControlCharacters(raw);
    const header = /^[├┌└]\s+(\w+)/.exec(line);
    if (header != null) {
      section = header[1];
      continue;
    }
    const entry = /^│\s+[+~-]\s+(\S+)/.exec(line);
    if (entry == null) continue;
    if (section === "Files") files.push(entry[1]);
    if (section === "Dependencies" || section === "DevDependencies")
      dependencies.push(entry[1].replace(/(?<=.)@.*$/, ""));
  }
  return { files, dependencies };
};

/** Run `add` against a snapshot (replay unless `record`). */
export const addFromSnapshot = async ({
  cwd = desktop,
  items,
  snapshot = latestSnapshot(),
  record = false,
  dryRun = false,
}) => {
  const proxy = await startRegistryProxy({
    mode: record ? "record" : "replay",
    dir: snapshot,
    cli: SHADCN_VERSION,
  });
  try {
    const out = await run(
      shadcnBin,
      [
        "add",
        ...items,
        "--yes",
        "--overwrite",
        ...(dryRun ? ["--dry-run"] : []),
      ],
      {
        cwd,
        capture: dryRun,
        env: {
          ...process.env,
          REGISTRY_URL: proxy.url,
          // The workspace pins a pnpm version the CLI's install would trip on.
          npm_config_pm_on_fail: "ignore",
        },
      }
    );
    if (proxy.misses.length > 0)
      throw new Error(`not in the snapshot: ${proxy.misses.join(", ")}`);
    return out;
  } finally {
    await proxy.close();
  }
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "add") fail("usage: shadcn-next.mjs add <items…> [--record]");
  const record = rest.includes("--record");
  const items = rest.filter((arg) => !arg.startsWith("--"));
  if (items.length === 0) fail("no items");

  // §5.1 step 5 / §13: the scoping and token lines app.css must keep.
  const css = readFileSync(
    join(desktop, "src/renderer-next/styles/app.css"),
    "utf8"
  );
  const missing = REQUIRED_CSS_LINES.filter((line) => !css.includes(line));
  if (missing.length > 0) fail(`styles/app.css lost: ${missing.join(" | ")}`);

  const snapshot = record
    ? join(desktop, "shadcn-registry", new Date().toISOString().slice(0, 10))
    : latestSnapshot();

  const plan = await addFromSnapshot({ items, snapshot, record, dryRun: true });
  const { files, dependencies } = parseDryRun(plan);
  if (files.length === 0) fail(`could not read the plan:\n${plan}`);
  const outside = files.filter(
    (file) => !ALLOWED_DIRS.some((dir) => file.startsWith(dir))
  );
  if (outside.length > 0)
    fail(`would write outside renderer-next: ${outside.join(", ")}`);
  const foreign = dependencies.filter(
    (name) => !REGISTRY_DEPENDENCIES.includes(name)
  );
  if (foreign.length > 0)
    fail(`plans dependencies outside the allowlist: ${foreign.join(", ")}`);
  console.log(`shadcn-next: plan ok (${files.length} files)`);

  await addFromSnapshot({ items, snapshot });

  const info = JSON.parse(
    execFileSync(shadcnBin, ["info", "--json"], {
      cwd: desktop,
      encoding: "utf8",
    })
  );
  const rel = (path) => path.replace(`${desktop}/`, "");
  if (rel(info.config.resolvedPaths.ui) !== "src/renderer-next/ui")
    fail(`ui resolves to ${info.config.resolvedPaths.ui}`);
  if (
    rel(info.config.resolvedPaths.tailwindCss) !==
    "src/renderer-next/styles/app.css"
  )
    fail(`css resolves to ${info.config.resolvedPaths.tailwindCss}`);
  if (info.config.iconLibrary !== "lucide")
    fail(`icons are ${info.config.iconLibrary}`);
  const dirty = execFileSync("git", ["status", "--porcelain", "src/renderer"], {
    cwd: desktop,
    encoding: "utf8",
  });
  if (dirty.trim() !== "") fail(`src/renderer changed:\n${dirty}`);
  console.log("shadcn-next: added; run oxfmt on src/renderer-next/ui");
};

if (import.meta.url === `file://${process.argv[1]}`) await main();
