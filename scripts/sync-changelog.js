#!/usr/bin/env node
/**
 * Keep CHANGELOG.md complete, one `## <version> — <date>` section per release.
 * Hand-written sections (and `## Unreleased`) are kept verbatim; a release
 * nobody wrote up gets a one-line stand-in. Run as `pnpm changelog`, or from
 * the release build with `--upcoming <version>` and `--out <path>`. Needs `gh`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = "abacusai/abacusai-bot";

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const upcomingVersion = flag("--upcoming");
const outPath = flag("--out") ?? "CHANGELOG.md";

const gh = (ghArgs) =>
  execFileSync("gh", ghArgs, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

const releases = JSON.parse(
  gh(["api", `repos/${REPO}/releases?per_page=100`, "--paginate"])
);

/** The file's existing sections by version, heading included; kept verbatim. */
const handWritten = () => {
  const path = resolve(process.cwd(), "CHANGELOG.md");
  if (!existsSync(path)) return new Map();
  const sections = new Map();
  let version = null;
  let lines = [];
  const flush = () => {
    if (version != null) sections.set(version, lines.join("\n").trimEnd());
    lines = [];
  };
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const heading = line.match(/^## (\S+)/u);
    if (heading != null) {
      flush();
      version = heading[1];
    }
    if (version != null) lines.push(line);
  }
  flush();
  return sections;
};

const written = handWritten();

/** What a release says when nobody wrote it up. */
const DEFAULT_NOTES = "Bug fixes, improvements in quality and speed.";

const section = (version, date) =>
  [`## ${version} — ${date}`, "", DEFAULT_NOTES].join("\n");

const published = releases
  .filter((release) => !release.draft && !release.prerelease)
  .sort((a, b) => (a.published_at < b.published_at ? 1 : -1));

const sections = published
  // The release being built may already exist on a re-run of the publish
  // job; the section for it below stands in either way.
  .filter((release) => release.tag_name.replace(/^v/u, "") !== upcomingVersion)
  .map((release) => {
    const version = release.tag_name.replace(/^v/u, "");
    return (
      written.get(version) ??
      section(version, (release.published_at ?? "").slice(0, 10))
    );
  });

if (upcomingVersion != null) {
  const today = new Date().toISOString().slice(0, 10);
  const unreleased = written.get("Unreleased");
  if (written.has(upcomingVersion)) {
    // Written up ahead of the cut, under its number.
    sections.unshift(written.get(upcomingVersion));
  } else if (unreleased != null) {
    // Written up under "Unreleased": this is the release it becomes.
    sections.unshift(
      unreleased.replace(
        /^## Unreleased.*$/mu,
        `## ${upcomingVersion} — ${today}`
      )
    );
  } else {
    sections.unshift(section(upcomingVersion, today));
  }
} else if (written.has("Unreleased")) {
  // Kept on top until a build turns it into a version.
  sections.unshift(written.get("Unreleased"));
}

const out = resolve(process.cwd(), outPath);
writeFileSync(
  out,
  [
    "# Changelog",
    "",
    "<!-- One section per version: `## 1.0.62 — 2026-09-09`. Write freely under",
    "     it — prose, ### headings, bullets. Notes for the next release go under",
    "     `## Unreleased`. Sections here are kept as written; a release nobody",
    '     wrote up says "Bug fixes, improvements in quality and speed." -->',
    "",
    ...sections.flatMap((s) => [s, ""]),
  ].join("\n"),
  "utf8"
);
console.log(`wrote ${sections.length} releases to ${out}`);
