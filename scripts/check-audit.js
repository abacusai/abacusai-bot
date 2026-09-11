#!/usr/bin/env node

/**
 * `pnpm audit` with a documented exception list. An audit that stays red on an
 * advisory with no patched release trains people to ignore it, so accepted
 * advisories are listed here with the reason and the condition for deleting
 * them; anything not listed still fails. Fixable ones go in `overrides`.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** `accepted`: GHSA id -> why it is accepted and when the entry must go. */
const TARGETS = {
  workspace: {
    packageManager: "pnpm",
    cwd: repoRoot,
    accepted: {
      // Both name a patched version npm does not have yet, so there is nothing
      // to pin in `overrides`; both are defended at the call site. When the
      // release lands, the stale-entry check below fails on the entry.
      "GHSA-w3rx-r6r6-pgpr":
        "image-size <=2.0.2 via pptxgenjs: the ICNS parser hangs on a crafted " +
        "image. deck-pptx-export.ts only hands pptxgenjs images whose content " +
        "signature is on its allowlist (isSupportedImage), which was written " +
        "for this advisory and its sibling — ICNS, JXL and HEIF never reach " +
        "image-size. Delete when image-size >=2.0.3 ships.",
      "GHSA-5p2g-fcmc-qvqq":
        "image-size <=2.0.2 via pptxgenjs: the JXL and HEIF parsers hang on a " +
        "crafted image. Same allowlist as GHSA-w3rx-r6r6-pgpr above, and the " +
        "same reason it cannot be reached. Delete when image-size >=2.0.3 ships.",
      "GHSA-jmr9-qjv8-65gv":
        "extract-zip <=2.0.1: a zip whose entries are symlinks can write " +
        "outside the extraction directory. The one caller, " +
        "experience-updater.ts, extracts only archives that have already " +
        "passed TUF verification, refuses symlink entries in its onEntry hook " +
        "(the S_IFLNK mode check) before extract-zip acts on them, and " +
        "re-verifies every extracted file against the manifest's digests. " +
        "Delete when extract-zip >=2.0.2 ships.",
      "GHSA-7pqw-9j4j-h8q3":
        "extract-zip <=2.0.1: the same symlink write, filed a second time. " +
        "The defence is the one described for GHSA-jmr9-qjv8-65gv above, and " +
        "2.0.2 is still the newest release that does not exist. Delete when " +
        "extract-zip >=2.0.2 ships.",
    },
  },
};

const targetName = /** @type {keyof typeof TARGETS} */ (
  process.argv[2] ?? "workspace"
);
const target = Object.hasOwn(TARGETS, targetName)
  ? TARGETS[targetName]
  : undefined;
if (!target) {
  console.error(
    `[audit] unknown target "${targetName}" — expected one of: ${Object.keys(TARGETS).join(", ")}`
  );
  process.exit(1);
}

const ACCEPTED = /** @type {Record<string, string>} */ (target.accepted);
const SEVERE = new Set(["high", "critical"]);

// Windows ships the package managers as .cmd shims, which Node will not
// spawn without a shell.
const command =
  process.platform === "win32"
    ? { file: `${target.packageManager}.cmd`, useShell: true }
    : { file: target.packageManager, useShell: false };

let report;
try {
  report = JSON.parse(
    execFileSync(command.file, ["audit", "--json", "--audit-level=high"], {
      cwd: target.cwd,
      shell: command.useShell,
      encoding: "utf8",
      // Both audits exit non-zero when they find anything; the JSON is still on
      // stdout and is the part that matters.
      stdio: ["ignore", "pipe", "inherit"],
    })
  );
} catch (err) {
  const stdout = /** @type {{ stdout?: string }} */ (err).stdout;
  if (stdout == null || stdout === "") throw err;
  report = JSON.parse(stdout);
}

// Normalize both shapes to `{ id, severity, module_name, title, where }`: pnpm
// keys advisories by numeric id (npm v6 shape); npm 7+ keys vulnerabilities by
// module, with the advisories as the object entries of each `via` array.
const advisories = [];

for (const advisory of Object.values(report.advisories ?? {})) {
  advisories.push({
    id:
      advisory.github_advisory_id ??
      String(advisory.url ?? "")
        .split("/")
        .pop(),
    severity: advisory.severity,
    module_name: advisory.module_name,
    title: advisory.title,
    where:
      (advisory.findings ?? []).flatMap(
        (/** @type {{ paths?: string[] }} */ f) => f.paths ?? []
      )[0] ?? advisory.module_name,
  });
}

for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    if (typeof via !== "object" || via === null) continue;
    advisories.push({
      id: String(via.url ?? "")
        .split("/")
        .pop(),
      severity: via.severity,
      module_name: via.name,
      title: via.title,
      where: vuln.name,
    });
  }
}

const seen = new Set();
const offenders = [];

for (const advisory of advisories) {
  if (!SEVERE.has(advisory.severity)) continue;

  if (ACCEPTED[advisory.id]) {
    seen.add(advisory.id);
    continue;
  }

  offenders.push(
    `${advisory.module_name}: ${advisory.title} (${advisory.id}, ${advisory.severity}) via ${advisory.where}`
  );
}

const stale = Object.keys(ACCEPTED).filter((id) => !seen.has(id));

if (offenders.length > 0) {
  console.error("[audit] high/critical advisories not on the accepted list:");
  for (const line of offenders) console.error(`  ${line}`);
  console.error(
    "\nFix it upstream, pin it in `overrides` in pnpm-workspace.yaml, or"
  );
  console.error(
    "add it to ACCEPTED in this file with the reason it is acceptable."
  );
  process.exit(1);
}

if (stale.length > 0) {
  console.error(
    "[audit] accepted advisories that no longer apply — delete them from scripts/check-audit.js:"
  );
  for (const id of stale) console.error(`  ${id}: ${ACCEPTED[id]}`);
  process.exit(1);
}

console.log(
  `[audit] ${targetName} clean at high/critical, ${Object.keys(ACCEPTED).length} documented exception(s)`
);
