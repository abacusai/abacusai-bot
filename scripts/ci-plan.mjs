// Which test suites a CI run needs. A pull request or a merge queue run runs
// the suites of the packages its diff reaches (turbo's --affected: changed
// packages and their dependents); a push to main, the scheduled run, a manual
// run, or a change to shared tooling runs everything.
// Writes `tests` (a job matrix) and the flags the other jobs read to
// $GITHUB_OUTPUT.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// A pull request diffs against its base branch; a merge queue run, which has
// no base branch, against the commit its group starts from.
const base = process.env.GITHUB_BASE_REF
  ? `origin/${process.env.GITHUB_BASE_REF}`
  : process.env.MERGE_GROUP_BASE_SHA || "";
const changed = base
  ? execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)
  : [];
// Files every package reads: a change here is a change to all of them.
const SHARED =
  /^(package\.json|pnpm-(lock|workspace)\.yaml|turbo\.json|\.nvmrc|tsconfig[^/]*\.json|packages\/config\/|\.github\/|scripts\/ci-plan\.mjs)/;
const full = !base || changed.some((file) => SHARED.test(file));

const affected = new Set(
  full
    ? []
    : JSON.parse(
        execFileSync(
          "pnpm",
          ["exec", "turbo", "ls", "--affected", "--output=json"],
          {
            encoding: "utf8",
            // Against the pull request's own base, which for a stacked
            // pull request is not main.
            env: { ...process.env, TURBO_SCM_BASE: base },
          }
        )
      ).packages.items.map((item) => item.name.replace("@abacus-ai/", ""))
);
const hit = (...names) => full || names.some((name) => affected.has(name));
// Web's tests also read the desktop main process (turbo.json inputs), and
// host builds it, so a desktop-only change reaches both.
const web = hit("web", "desktop");
const desktop = hit("desktop");
const agent = hit("agent");
const packages = hit("host", "contract", "updater", "connectors", "desktop");

const vitest = (dir, args = "") => `pnpm --dir ${dir} exec vitest run${args}`;
const tests = [];
// What each suite builds before it runs: its package and what it imports.
// turbo's test task builds the small packages' graphs itself.
const BUILD = {
  web: "pnpm exec turbo run build --filter=@abacus-ai/web^...",
  packages: "true",
  agent: "pnpm exec turbo run build vendor --filter=@abacus-ai/agent...",
  desktop: "pnpm run build",
};
const add = (when, name, suite, run) => {
  if (when) tests.push({ name, suite, build: BUILD[suite], run });
};
for (const shard of [1, 2, 3])
  add(web, `web ${shard}/3`, "web", vitest("apps/web", ` --shard=${shard}/3`));
add(
  packages,
  "host and packages",
  "packages",
  "pnpm exec turbo run test --filter=@abacus-ai/host --filter=@abacus-ai/contract --filter=@abacus-ai/updater --filter=@abacus-ai/connectors"
);
// The agent and the desktop main process are what differ across operating
// systems (sandbox confinement, cmd.exe quoting, paths, Electron itself); the
// renderer and the host are not, so they run on Linux alone. Linux runs them
// as separate jobs; macOS and Windows runners are scarce, so each of those
// runs them in one job (the `system` job), in parallel steps.
add(agent, "agent", "agent", vitest("packages/agent"));
add(
  desktop,
  "desktop",
  "desktop",
  vitest("apps/desktop", " --project main --project preload")
);
// The Electron suites run one file at a time, so two runners halve them.
for (const shard of [1, 2])
  add(
    desktop,
    `desktop electron ${shard}/2`,
    "desktop",
    vitest("apps/desktop", ` --project main-serial --shard=${shard}/2`)
  );
// PLATFORMS=linux (the workflow's platforms step) keeps macOS and Windows out:
// a pull request without `ci:all-os`, a push to main, a merge queue run with
// `ci:skip-os`, or a manual run that asks.
// A change to the renderer alone reaches the desktop app only as its built
// renderer, which Linux's Electron suites drive; macOS and Windows test what
// differs by system, so they wait for a change outside apps/web.
const beyondRenderer =
  full || changed.some((file) => !file.startsWith("apps/web/"));
const systems =
  (agent || (desktop && beyondRenderer)) && process.env.PLATFORMS !== "linux"
    ? ["macos-latest", "windows-latest"]
    : [];

const outputs = {
  tests: JSON.stringify({ include: tests }),
  any: String(tests.length > 0),
  agent: String(agent),
  desktop: String(desktop),
  systems: JSON.stringify(systems),
  // The migration kill-point matrix takes five minutes on Windows' file
  // system; off Linux it runs when migrations change, and on main.
  migrations: String(
    full ||
      changed.some((file) =>
        file.startsWith("apps/desktop/src/main/migrations/")
      )
  ),
};
const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
console.log(lines.join("\n"));
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
