#!/usr/bin/env node
/**
 * Regenerate src/renderer/routeTree.gen.ts without a Vite run, with the
 * same options vite.config.ts gives the router plugin. The plugin also does
 * this on every dev start and build; this is for tests and CI checks.
 */
import { join } from "node:path";

import { Generator, getConfig } from "@tanstack/router-generator";

const desktop = join(import.meta.dirname, "..");

const config = getConfig(
  {
    target: "react",
    routesDirectory: "./src/renderer/routes",
    generatedRouteTree: "./src/renderer/routeTree.gen.ts",
    routeFileIgnorePrefix: "-",
    quoteStyle: "double",
    disableLogging: true,
  },
  desktop
);

const generator = new Generator({ config, root: desktop });
await generator.run();
console.log("generate-routes: routeTree.gen.ts up to date");
