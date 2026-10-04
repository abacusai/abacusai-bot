import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { loadEnv, type Plugin, type PluginOption } from "vite";

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
  const sources =
    env.VITE_CONNECT_SRC ??
    "'self' https://*.preview.apps.abacus.ai wss://*.preview.apps.abacus.ai";
  if (!sources.trim())
    throw new Error("VITE_CONNECT_SRC is required for browser builds");
  return CSP_BASE + `connect-src ${sources};`;
};
export const platformAlias = (platform: RendererPlatform) =>
  Object.fromEntries(
    [
      "ask-host",
      "companion",
      "about",
      "updates",
      "local-models",
      "browser-tab",
      "device-tab",
      "presenter",
      "transport",
      "host-files",
      "connect",
      "lease",
      "sign-in",
      "system",
      "files",
      "attention",
    ].map((name) => [
      `#platform/${name}`,
      resolve(
        webRoot,
        `src/platform/${platform === "electron" && ["system", "sign-in", "files", "attention", "lease"].includes(name) ? "adapters" : name}.${platform}.${["presenter", "transport", "host-files", "lease", "sign-in", "system", "files", "attention"].includes(name) ? "ts" : "tsx"}`
      ),
    ])
  );
export const assertBrowserImport = (resolved: string): void => {
  const id = resolved.replaceAll("\\", "/");
  if (
    /\/src\/(?:features\/(?:notch\/|sessions\/(?:device|browser)\/|onboarding\/steps\/local-models\.|settings\/(?:updates|companion)\.|shell\/native-presenter\.)|platform\/[^/]*\.electron\.|data\/transport\/message-port\.|lib\/window-chrome\/|components\/(?:device|browser-surface)\/)/.test(
      id
    )
  )
    throw new Error(
      `Electron-only module in browser build: ${id}. Use #platform aliasing.`
    );
};
export const browserBoundaryPlugin = (): Plugin => ({
  enforce: "pre",
  name: "abacus:browser-boundary",
  resolveId: {
    order: "pre",
    async handler(
      this: import("vite").Rolldown.PluginContext,
      id: string,
      importer: string | undefined
    ) {
      const resolved = await this.resolve(id, importer, { skipSelf: true });
      if (resolved) assertBrowserImport(resolved.id);
      return resolved;
    },
  },
  load(id) {
    assertBrowserImport(id);
    return null;
  },
  transform(_code, id) {
    assertBrowserImport(id);
    return null;
  },
  generateBundle() {
    for (const id of this.getModuleIds()) assertBrowserImport(id);
  },
});
export const platformPlugin = (
  platform: RendererPlatform,
  mode = "production",
  command = "build"
) => {
  const env = {
    ...(platform === "browser" ? loadEnv(mode, webRoot, "VITE_") : {}),
    ...process.env,
  };
  if (platform === "browser" && command === "serve" && env.VITE_WEB_HOST_URL) {
    const origin = new URL(env.VITE_WEB_HOST_URL).origin;
    env.VITE_CONNECT_SRC = `${env.VITE_CONNECT_SRC ?? "'self' https://*.preview.apps.abacus.ai wss://*.preview.apps.abacus.ai"} ${origin} ${origin.replace(/^ws/, "http")}`;
  }
  const csp = rendererCsp(platform, env);
  return {
    name: "abacus:platform",
    config: () => ({
      define: { __ABACUS_PLATFORM__: JSON.stringify(platform) },
    }),
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: csp },
        injectTo: "head-prepend" as const,
      },
    ],
  };
};
export const rendererPlugins = (
  platform: RendererPlatform,
  command: string,
  mode = "production"
): PluginOption[] => {
  const root = webRoot;
  const flags = {
    gallery: process.env.VITE_UI_GALLERY === "1",
    fixtures: process.env.VITE_NEXT_DB_FIXTURES === "1",
  };
  const release = command === "build" && !flags.gallery && !flags.fixtures;
  return [
    platformPlugin(platform, mode, command),
    ...(platform === "browser" ? [browserBoundaryPlugin()] : []),
    releaseBuildPlugin(root, release, flags, platform),
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
