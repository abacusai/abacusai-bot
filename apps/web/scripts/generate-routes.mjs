#!/usr/bin/env node
/**
 * Regenerate src/routeTree.gen.ts without a Vite run, with the
 * same options vite.config.ts gives the router plugin. The plugin also does
 * this on every dev start and build; this is for tests and CI checks.
 */
import { join } from "node:path";

import { Generator, getConfig } from "@tanstack/router-generator";

const web = join(import.meta.dirname, "..");

const config = getConfig(
  {
    target: "react",
    routesDirectory: "./src/routes",
    generatedRouteTree: "./src/routeTree.gen.ts",
    routeFileIgnorePrefix: "-",
    quoteStyle: "double",
    disableLogging: true,
  },
  web
);

const generator = new Generator({ config, root: web });
await generator.run();
console.log("generate-routes: routeTree.gen.ts up to date");
