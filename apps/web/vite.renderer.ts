import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import MagicString from "magic-string";
import { loadEnv, type PluginOption } from "vite";

import { releaseBuildPlugin } from "../desktop/scripts/release-build-plugin.mjs";
import {
  RENDERER_MODULES,
  RENDERER_REGISTRY_SRC,
  RENDERER_APP_SRC,
  NODE_MODULES,
  alias as desktopAlias,
} from "../desktop/vite.shared";

export const webRoot = import.meta.dirname;
export const rendererAlias = {
  ...desktopAlias,
  "ort-dist": resolve(webRoot, "../../node_modules/onnxruntime-web/dist"),
};
export type RendererPlatform = "electron" | "browser";
const CSP_BASE =
  "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; media-src 'self' blob: data:; img-src 'self' blob: data:; ";
export const rendererCsp = (
  platform: RendererPlatform,
  env = process.env
): string => {
  if (platform !== "electron" && platform !== "browser")
    throw new Error("Renderer platform is required");
  if (platform === "electron") return CSP_BASE + "connect-src 'self' data:;";
  if (!env.VITE_CONNECT_SRC)
    throw new Error("VITE_CONNECT_SRC is required for browser builds");
  const sources = [
    "'self'",
    "https://apps.abacus.ai",
    "https://*.preview.apps.abacus.ai",
    "wss://*.preview.apps.abacus.ai",
  ];
  if (env.VITE_ABACUS_ENV === "staging")
    sources.push(
      "https://staging-apps.abacus.ai",
      "https://*.preview.staging-apps.abacus.ai",
      "wss://*.preview.staging-apps.abacus.ai"
    );
  sources.push(env.VITE_CONNECT_SRC);
  return CSP_BASE + `connect-src ${[...new Set(sources)].join(" ")};`;
};
export const platformPlugin = (platform: RendererPlatform) => {
  const csp = rendererCsp(platform, {
    ...loadEnv("production", webRoot, "VITE_"),
    ...process.env,
  });
  return {
    name: "abacus:platform",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (
        !id.replaceAll("\\", "/").includes("/apps/web/src/") ||
        id.endsWith("/lib/platform.ts")
      )
        return;
      // Imported constants are propagated after Rolldown discovers dynamic
      // entries. Make the gates defines before that discovery instead.
      const result = new MagicString(code);
      for (const match of code.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*["'](?:#renderer\/lib\/platform|\.\/platform)["'];?/g
      )) {
        const bindings = match[1]!;
        const retained = bindings
          .split(",")
          .map((binding) => binding.trim())
          .filter(
            (binding) => !["IS_ELECTRON", "IS_BROWSER"].includes(binding)
          );
        result.overwrite(
          match.index!,
          match.index! + match[0].length,
          retained.length ? match[0].replace(bindings, retained.join(", ")) : ""
        );
      }
      return {
        code: result.toString(),
        map: result.generateMap({ hires: true }),
      };
    },
    config: () => ({
      define: {
        __ABACUS_PLATFORM__: JSON.stringify(platform),
        IS_ELECTRON: JSON.stringify(platform === "electron"),
        IS_BROWSER: JSON.stringify(platform === "browser"),
      },
    }),
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: csp },
        injectTo: "head" as const,
      },
    ],
  };
};
export const rendererPlugins = (
  platform: RendererPlatform,
  command: string
): PluginOption[] => {
  const root = webRoot;
  const flags = {
    gallery: process.env.VITE_UI_GALLERY === "1",
    fixtures: process.env.VITE_NEXT_DB_FIXTURES === "1",
  };
  const release = command === "build" && !flags.gallery && !flags.fixtures;
  return [
    platformPlugin(platform),
    releaseBuildPlugin(root, release, flags),
    // Before the React transform: it rewrites route files into split chunks.
    tanstackRouter({
      target: "react",
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      routeFileIgnorePrefix: "-",
      autoCodeSplitting: true,
      quoteStyle: "double",
    }),
    tanstackRouter({
      target: "react",
      routesDirectory: "./src/notch-routes",
      generatedRouteTree: "./src/notchRouteTree.gen.ts",
      routeFileIgnorePrefix: "-",
      autoCodeSplitting: true,
      quoteStyle: "double",
    }),
    tailwindcss(),
    // Order matters (spec 01 §3.3): the compiler instance first, the plain
    // instance last. Each sets oxc's refresh flag in its `config` hook and the
    // last one wins, so reversed, the old renderer loses Fast Refresh. The
    // compiler instance does its own refresh for the files it compiles.
    react({
      include: RENDERER_MODULES,
      exclude: RENDERER_REGISTRY_SRC,
      compiler: { logDiagnostics: true },
    }),
    react({ exclude: [NODE_MODULES, RENDERER_APP_SRC] }),
  ];
};
