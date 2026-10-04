import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import { releaseBuildPlugin } from "../desktop/scripts/release-build-plugin.mjs";
import {
  alias,
  RENDERER_MODULES,
  RENDERER_REGISTRY_SRC,
} from "../desktop/vite.shared";
import { browserBoundaryPlugin, platformAlias, webRoot } from "./vite.renderer";
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
    projects: ["electron", "browser"].map((platform) => ({
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
        react({
          include: RENDERER_MODULES,
          exclude: RENDERER_REGISTRY_SRC,
          compiler: true,
        }),
      ],
      resolve: {
        alias: {
          ...alias,
          ...platformAlias(platform as "electron" | "browser"),
          "ort-dist": resolve(
            import.meta.dirname,
            "../../node_modules/onnxruntime-web/dist"
          ),
        },
      },
      test: {
        ...(process.env.CI ? { hookTimeout: 30_000, testTimeout: 30_000 } : {}),
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
  },
});
