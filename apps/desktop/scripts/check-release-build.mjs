import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertUpgradeVersion } from "./check-release-versions.mjs";
const desktop = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
export const checkReleaseBuild = (dist = path.join(desktop, "dist")) => {
  assertUpgradeVersion(
    JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"))
      .version
  );
  for (const name of ["index.html", "notch.html"])
    if (!fs.existsSync(path.join(dist, "renderer", name)))
      throw new Error(`Missing renderer entry: ${name}`);
  const policy = JSON.parse(
    fs.readFileSync(path.join(dist, "renderer", "release-build.json"), "utf8")
  );
  if (policy.gallery || policy.fixtures || !Array.isArray(policy.modules))
    throw new Error(
      "Release build has gallery/fixture flags or lacks its module graph"
    );
  const forbiddenModule =
    /(?:\/data\/fixture-db\/|\/dev\/dev-hooks\.|\/dev\/mutation-harness\.|\/features\/[^/]+\/gallery(?:\/|\.)|\/features\/gallery\/|\/__fixtures__\/|\/scenarios\/)/;
  const shipped = policy.modules.filter((id) => forbiddenModule.test(id));
  if (shipped.length)
    throw new Error(
      `Development modules in release graph: ${shipped.join(", ")}`
    );
  const forbidden = [
    /__abacusDev/,
    /renderer fixture-db: dev fixture tables/,
    /TanStackDevtools/,
    /ReactQueryDevtools/,
    /TanStackRouterDevtools/,
    /mutation-harness/,
    /guardSingleViewTransition/,
  ];
  const walk = (dir) =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory()
          ? walk(path.join(dir, e.name))
          : [path.join(dir, e.name)]
      );
  for (const dir of ["renderer", "main"])
    for (const file of walk(path.join(dist, dir))) {
      if (!/\.(?:js|cjs|mjs|html)$/.test(file)) continue;
      const source = fs.readFileSync(file, "utf8");
      if (forbidden.some((pattern) => pattern.test(source)))
        throw new Error(
          `Development code in release: ${path.relative(dist, file)}`
        );
    }
  // Guard the boot graph, including HTML modulepreloads. Route guards may stay
  // eager; presentation code must wait for its route or user interaction.
  const chunks = JSON.parse(
    fs.readFileSync(path.join(dist, "renderer", "chunk-sizes.json"), "utf8")
  );
  const initial = new Set(
    [
      ...fs
        .readFileSync(path.join(dist, "renderer", "index.html"), "utf8")
        .matchAll(/(?:src|href)="([^"?#]+\.js)"/g),
    ].map((match) => match[1].replace(/^\.?\//, ""))
  );
  const visit = (file) => {
    const chunk = chunks.find((entry) => entry.file === file);
    for (const dependency of chunk?.imports ?? []) {
      if (!initial.has(dependency)) {
        initial.add(dependency);
        visit(dependency);
      }
    }
  };
  for (const file of initial) visit(file);
  const bootModules = chunks
    .filter((chunk) => initial.has(chunk.file))
    .flatMap((chunk) => chunk.modules.map((module) => module.id));
  const deferred =
    /(?:\/components\/(?:editor|terminal)\/|\/ghostty-web\/|\/features\/chat\/markdown\/|\/@tanstack\/(?:markdown|highlight)\/|\/features\/notch\/|\/kit\/permissions\/notch-list\.|\/features\/onboarding\/(?:steps\/|gallery\.|index\.|hatch\.)|\/features\/tour\/(?:index\.|gallery\.)|\/features\/gallery\/)/;
  const eager = bootModules.filter((id) => deferred.test(id));
  if (eager.length)
    throw new Error(
      `Deferred presentation code in initial bundle: ${eager.join(", ")}`
    );
  // Only the shell's named icons belong here, never the full icon catalog.
  const icons = bootModules.filter((id) =>
    /\/lucide-react\/.*\/icons\//.test(id)
  );
  if (icons.length > 100)
    throw new Error(
      `Heavy icon catalog in initial bundle: ${icons.length} icons`
    );
  return policy;
};
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  checkReleaseBuild(process.argv[2]);
  console.log("check-release-build: release graph and output clean");
}
