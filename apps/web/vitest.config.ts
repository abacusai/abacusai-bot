import { defineConfig } from "vitest/config";

import { releaseBuildPlugin } from "./scripts/release-build-plugin.mjs";
import {
  browserBoundaryPlugin,
  compilerReact,
  rendererAliases,
  webRoot,
} from "./vite.renderer.ts";
export default defineConfig({
  test: {
    maxWorkers: process.env.CI ? 2 : 4,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html"],
      exclude: [
        "**/*.test.*",
        "**/dist/**",
        "**/*.config.ts",
        "src/locales/**",
        "src/routeTree.gen.ts",
        "src/ui/**",
      ],
    },
    projects: [
      // The build tooling beside the config files, in Node.
      {
        test: {
          name: "vite",
          environment: "node",
          include: ["vite.*.test.ts"],
          // Two full browser builds run in here.
          testTimeout: process.env.CI ? 120_000 : 60_000,
        },
      },
      ...["electron", "browser"].map((platform) => ({
        define: { __ABACUS_PLATFORM__: JSON.stringify(platform) },
        plugins: [
          ...(platform === "browser"
            ? [
                browserBoundaryPlugin(),
                // Match the shipped browser graph: the internal UI gallery is pruned.
                releaseBuildPlugin(
                  webRoot,
                  true,
                  { gallery: false, fixtures: false },
                  "browser"
                ),
              ]
            : []),
          compilerReact(true),
        ],
        resolve: {
          alias: rendererAliases(platform as "electron" | "browser"),
        },
        test: {
          ...(process.env.CI
            ? { hookTimeout: 30_000, testTimeout: 30_000 }
            : {}),
          name: platform === "electron" ? "renderer" : "renderer-browser",
          environment: "jsdom",
          maxWorkers: process.env.CI ? 2 : 4,
          css: { include: [/tokens\.css/] },
          include:
            platform === "electron"
              ? ["src/**/*.test.{ts,tsx}"]
              : ["src/**/*.browser-gating.test.{ts,tsx}"],
          exclude:
            platform === "electron"
              ? ["src/**/*.browser-gating.test.{ts,tsx}"]
              : [],
          setupFiles: ["./src/test-support/setup.ts"],
        },
      })),
    ],
  },
});
