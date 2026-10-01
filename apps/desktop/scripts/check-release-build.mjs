import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const desktop = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
export const checkReleaseBuild = (dist = path.join(desktop, "dist")) => {
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
  return policy;
};
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  checkReleaseBuild(process.argv[2]);
  console.log("check-release-build: release graph and output clean");
}
