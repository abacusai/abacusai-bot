#!/usr/bin/env node

/**
 * Check that the packaged app carries the files it spawns at runtime.
 *
 * Everything here is code the app runs out of `Contents/Resources` rather than
 * out of the asar, which means nothing in the build — not typecheck, not the
 * test suite, not electron-builder itself — notices when a piece stops being
 * copied. The failure lands on the user instead, as a runtime "Cannot find
 * package" the moment the app spawns what did not travel. Dev never shows it,
 * because dev runs everything from the repo.
 *
 * The trap is specific and repeatable: electron-builder's walker skips any
 * `node_modules` it meets inside a source tree, so a `from:` entry silently
 * ships everything except the dependencies. The agent hit it first. This asserts
 * the result rather than the config, so it holds whatever the config does next.
 *
 * Usage (after `pnpm package:dir`):
 *   node scripts/check-packaged-resources.js
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXE = process.platform === "win32" ? ".exe" : "";

/** Paths that must exist under the packaged app's resources directory. */
const REQUIRED = [
  "LICENSE",
  "THIRD-PARTY-NOTICES.txt",
  "agent/main.js",
  // Left out of the agent bundle because it loads a native addon, so it has to
  // be resolvable from beside the bundle at run time.
  "agent/node_modules/@ast-grep/napi",
  // The agent's `grep` and `find` spawn these. Shipped because the alternative
  // is downloading them from GitHub the first time the model searches, which
  // fails outright on a machine that cannot reach it.
  `agent/vendor/rg${EXE}`,
  `agent/vendor/fd${EXE}`,
  // The POSIX shell `bash` runs under on Windows; without it every command
  // the model writes fails on a machine with no Git Bash.
  ...(process.platform === "win32" ? ["agent/vendor/busybox.exe"] : []),
  // The Windows sandbox runner (packages/agent/src/sandbox/mxc.ts); without it
  // every confined command is refused on a Windows 11 24H2 machine.
  ...(process.platform === "win32" ? ["agent/vendor/mxc/wxc-exec.exe"] : []),
  "vendor/scrcpy-server.jar",
  "skills",
];

/**
 * Paths that must NOT exist. Historically the licence trap: the retired
 * WhatsApp bridge's GPL-3.0 dependency tree once shipped inside this MIT
 * artifact, and asserting on the built app is what caught it. Kept (empty)
 * so the next entry has somewhere obvious to go.
 */
const FORBIDDEN = [];

/** Where electron-builder --dir leaves the resources, per platform. */
function resourcesDir() {
  const dist = path.join(import.meta.dirname, "..", "release");
  if (!fs.existsSync(dist)) {
    throw new Error("No release/ directory. Run `pnpm package:dir` first.");
  }

  const candidates = [];
  for (const entry of fs.readdirSync(dist)) {
    const base = path.join(dist, entry);
    // macOS: dist/mac-arm64/AbacusAI-Bot.app/Contents/Resources
    if (entry.startsWith("mac")) {
      for (const inner of fs.existsSync(base) ? fs.readdirSync(base) : []) {
        if (inner.endsWith(".app"))
          candidates.push(path.join(base, inner, "Contents", "Resources"));
      }
    }
    // Windows and Linux: dist/<name>-unpacked/resources
    if (entry.endsWith("unpacked"))
      candidates.push(path.join(base, "resources"));
  }

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found == null) {
    throw new Error(
      `No unpacked app found under ${dist}. Looked for: ${candidates.join(", ") || "(nothing)"}`
    );
  }

  return found;
}

function main() {
  const resources = resourcesDir();
  const missing = REQUIRED.filter(
    (relative) => !fs.existsSync(path.join(resources, relative))
  );
  const shipped = FORBIDDEN.filter((relative) =>
    fs.existsSync(path.join(resources, relative))
  );

  if (shipped.length > 0) {
    console.error(
      `[packaged-resources] shipped and must not be, in ${resources}:`
    );
    for (const relative of shipped) console.error(`  - ${relative}`);
    console.error(
      `\nWhatever put these paths back into the build, the entry in FORBIDDEN ` +
        `above says why they must not ship. Fix the build, not the list.`
    );
    process.exit(1);
  }

  if (missing.length > 0) {
    console.error(`[packaged-resources] missing from ${resources}:`);
    for (const relative of missing) console.error(`  - ${relative}`);
    console.error(
      `\nA path that exists in the repo but not here is usually electron-builder's ` +
        `walker skipping a nested node_modules. Give that directory its own ` +
        `\`from:\` entry in electron-builder.yml.`
    );
    process.exit(1);
  }

  // Present is not the same as usable. A binary that lost its executable bit on
  // the way into the bundle, or that was packaged for another architecture,
  // exists at exactly the right path and still cannot answer a search — and
  // that failure would reach the user as `grep` reporting itself unavailable.
  const dead = [];
  for (const tool of ["rg", "fd"]) {
    const binary = path.join(resources, "agent", "vendor", tool + EXE);
    const probe = spawnSync(binary, ["--version"], { encoding: "utf8" });

    if (probe.status !== 0) {
      dead.push(
        `${tool} — ${(probe.error?.message ?? probe.stderr ?? `exit ${probe.status}`).trim()}`
      );
    } else {
      console.log(
        `[packaged-resources] ${tool}: ${probe.stdout.trim().split("\n")[0]}`
      );
    }
  }

  if (process.platform === "win32") {
    const binary = path.join(resources, "agent", "vendor", "busybox.exe");
    const probe = spawnSync(binary, ["sh", "-c", "printf ok"], {
      encoding: "utf8",
    });

    if (probe.status !== 0 || probe.stdout !== "ok") {
      dead.push(
        `busybox — ${(probe.error?.message ?? probe.stderr ?? `exit ${probe.status}`).trim()}`
      );
    } else {
      console.log(`[packaged-resources] busybox: sh -c works`);
    }
  }

  if (dead.length > 0) {
    console.error(`[packaged-resources] shipped but not runnable:`);
    for (const line of dead) console.error(`  - ${line}`);
    process.exit(1);
  }

  console.log(
    `[packaged-resources] all ${REQUIRED.length} required paths present in ${resources}`
  );
}

main();
