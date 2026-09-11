/**
 * Build the deterministic experience artifact: the renderer bundle
 * (dist/renderer) and the agent bundle (packages/agent/dist, filtered the
 * same way electron-builder ships it — no source maps, declarations, or
 * build stamps) as one canonical tree plus a byte-reproducible zip at
 * dist/experience/experience.zip.
 *
 * Requires the workspace to be built (`turbo run build`); the experience
 * turbo task declares those dependencies.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const repoRoot = path.join(desktopRoot, "..", "..");
const rendererDist = path.join(desktopRoot, "dist", "renderer");
const agentDist = path.join(repoRoot, "packages", "agent", "dist");
const agentStaging = path.join(desktopRoot, "dist", "experience-agent");
const output = path.join(desktopRoot, "dist", "experience");

// The foundation release this bundle belongs to. build.sh sets this same
// field before packaging, so the stamp is what app.getVersion() will report.
const foundation = JSON.parse(
  fs.readFileSync(path.join(desktopRoot, "package.json"), "utf-8")
).version;

for (const [name, dir] of [
  ["renderer", rendererDist],
  ["agent", agentDist],
]) {
  if (!fs.existsSync(path.join(dir))) {
    console.error(
      `The ${name} build is missing at ${dir}; run the build first.`
    );
    process.exit(1);
  }
}

// Same exclusions as electron-builder.yml's agent extraResources filter.
const excluded = (name) =>
  name.endsWith(".map") ||
  name.endsWith(".d.ts") ||
  name.endsWith(".tsbuildinfo") ||
  name === ".tsbuildinfo";

fs.rmSync(agentStaging, { force: true, recursive: true });
fs.cpSync(agentDist, agentStaging, {
  filter: (source) => {
    const stat = fs.statSync(source);

    return stat.isDirectory() ? true : !excluded(path.basename(source));
  },
  recursive: true,
});

execFileSync(
  process.execPath,
  [
    path.join(repoRoot, "apps", "updater", "dist", "experience.mjs"),
    "--renderer",
    rendererDist,
    "--agent",
    agentStaging,
    "--output",
    output,
    "--foundation",
    foundation,
  ],
  { stdio: "inherit" }
);

const manifest = JSON.parse(
  fs.readFileSync(path.join(output, "current", "manifest.json"), "utf-8")
);

console.log(
  `Experience ${manifest.experienceVersion} for foundation ${manifest.foundation} (renderer ${manifest.rendererVersion.slice(0, 12)}, agent ${manifest.agentVersion.slice(0, 12)}) at ${output}`
);
