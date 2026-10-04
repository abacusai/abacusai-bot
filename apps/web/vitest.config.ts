import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import {
  alias,
  RENDERER_MODULES,
  RENDERER_REGISTRY_SRC,
} from "../desktop/vite.shared";
export default defineConfig({
  test: {
    maxWorkers: 4,
    projects: ["electron", "browser"].map((platform) => ({
      define: { __ABACUS_PLATFORM__: JSON.stringify(platform) },
      plugins: [
        react({
          include: RENDERER_MODULES,
          exclude: RENDERER_REGISTRY_SRC,
          compiler: true,
        }),
      ],
      resolve: {
        alias: {
          ...alias,
          "ort-dist": resolve(
            import.meta.dirname,
            "../../node_modules/onnxruntime-web/dist"
          ),
        },
      },
      test: {
        name: platform === "electron" ? "renderer" : "renderer-browser",
        environment: "jsdom",
        maxWorkers: 4,
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
