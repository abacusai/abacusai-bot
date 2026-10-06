#!/usr/bin/env node
/**
 * Regenerate src/routeTree.gen.ts and src/notchRouteTree.gen.ts without a
 * Vite run, with the same options vite.renderer.ts gives the router plugins.
 * The plugins also do this on every dev start and build, and write nothing
 * when the tree is current. `check` runs this first (turbo's
 * `@abacus-ai/web#generate:routes`), so the readers that run beside the
 * builds (format, lint, knip, typecheck, the i18n scans) never see a build
 * rewriting a stale tree.
 */
import { join } from "node:path";

import { Generator, getConfig } from "@tanstack/router-generator";

const web = join(import.meta.dirname, "..");

for (const [routesDirectory, generatedRouteTree] of [
  ["./src/routes", "./src/routeTree.gen.ts"],
  ["./src/notch-routes", "./src/notchRouteTree.gen.ts"],
]) {
  const config = getConfig(
    {
      target: "react",
      routesDirectory,
      generatedRouteTree,
      routeFileIgnorePrefix: "-",
      quoteStyle: "double",
      disableLogging: true,
    },
    web
  );
  await new Generator({ config, root: web }).run();
}
console.log("generate-routes: route trees up to date");
