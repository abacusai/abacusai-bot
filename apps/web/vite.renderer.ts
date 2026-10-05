import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { loadEnv, type Plugin, type PluginOption } from "vite";

import { releaseBuildPlugin } from "./scripts/release-build-plugin.mjs";
import {
  RENDERER_MODULES,
  RENDERER_REGISTRY_SRC,
  RENDERER_APP_SRC,
  NODE_MODULES,
  alias as desktopAlias,
} from "./vite.shared.ts";

export const webRoot = import.meta.dirname;
export const rendererAlias = {
  ...desktopAlias,
  "ort-dist": resolve(webRoot, "../../node_modules/onnxruntime-web/dist"),
};
export type RendererPlatform = "electron" | "browser";
const CSP_BASE =
  "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self' blob: data:; img-src 'self' blob: data:; ";
export const rendererCsp = (
  platform: RendererPlatform,
  env = process.env
): string => {
  if (platform !== "electron" && platform !== "browser")
    throw new Error("Renderer platform is required");
  if (platform === "electron") return CSP_BASE + "connect-src 'self' data:;";
  // The host is proxied same-origin; VITE_CONNECT_SRC only adds extra sources.
  const sources = new Set([
    "'self'",
    ...(env.VITE_CONNECT_SRC ?? "").split(/\s+/),
  ]);
  sources.delete("");
  return (
    CSP_BASE + `connect-src ${[...sources].join(" ")}; frame-src 'self' blob:;`
  );
};
/** `#platform/<name>` → `src/platform/<name>.<platform>.ts(x)`, one per file. */
export const platformAlias = (platform: RendererPlatform) =>
  Object.fromEntries(
    readdirSync(resolve(webRoot, "src/platform")).flatMap((file) => {
      const name = new RegExp(`^(.+)\\.${platform}\\.tsx?$`).exec(file)?.[1];
      return name
        ? [[`#platform/${name}`, resolve(webRoot, "src/platform", file)]]
        : [];
    })
  );
/** Every alias one platform's renderer resolves: the shared roots and its `#platform` files. */
export const rendererAliases = (platform: RendererPlatform) => ({
  ...rendererAlias,
  ...platformAlias(platform),
});
/** The gallery and fixture flags; a build with neither is a release build. */
export const rendererFlags = (command: string) => {
  const gallery = process.env.VITE_UI_GALLERY === "1";
  const fixtures = process.env.VITE_NEXT_DB_FIXTURES === "1";
  return {
    gallery,
    fixtures,
    release: command === "build" && !gallery && !fixtures,
  };
};
/** React with the compiler for the app tree; the registry under src/ui/ stays plain. */
export const compilerReact = (
  compiler: NonNullable<Parameters<typeof react>[0]>["compiler"]
) =>
  react({
    include: RENDERER_MODULES,
    exclude: RENDERER_REGISTRY_SRC,
    compiler,
  });
export const assertBrowserImport = (resolved: string): void => {
  const id = resolved.replaceAll("\\", "/");
  if (
    /^#(?:main|preload)(?:\/|$)/.test(id) ||
    /\/apps\/desktop\/src\/(?:main|preload)\//.test(id) ||
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
    env.VITE_CONNECT_SRC = `${env.VITE_CONNECT_SRC ?? ""} ${origin} ${origin.replace(/^ws/, "http")}`;
  }
  const csp = rendererCsp(platform, env);
  return {
    name: "abacus:platform",
    config: () => ({
      define: { __ABACUS_PLATFORM__: JSON.stringify(platform) },
    }),
    transformIndexHtml: (html: string) => ({
      // The static splash is the browser's: Electron mounts from a local
      // file and keeps its blank first frame.
      html:
        platform === "electron"
          ? html.replace(/\s*<!-- splash:[\s\S]*<!-- \/splash -->\s*/, "")
          : html,
      tags: [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: csp },
          injectTo: "head-prepend" as const,
        },
      ],
    }),
  };
};
/**
 * Chunk groups both renderer builds share. Query's mutation hooks
 * (`useMutation`, `useMutationState` and the observer behind them) go in a
 * `mutations` chunk of their own. The settings, library and session pages
 * use them, and so does the main window's entry (the title bar's update
 * action, settings/updates.tsx), which therefore loads the chunk at start;
 * the notch, which never mutates, does not. Without the group, each set of
 * pages sharing them split off a chunk of its own; folded into the module
 * both documents share, the notch would load them. The match is by package
 * and file name, not by the packages' build directories, and the bundle
 * guard (scripts/check-web-bundle.mjs) checks the chunk holds exactly these
 * modules and stays out of the notch.
 */
export const rendererChunkGroups = {
  groups: [
    {
      name: "mutations",
      // Only these modules: their dependencies (React, query-core's
      // managers, mutation.js for the cache) stay in the entry chunks, which
      // never import this one back.
      includeDependenciesRecursively: false,
      test: /[\\/]@tanstack[\\/](?:react-query[\\/](?:.+[\\/])?(?:useMutation|useMutationState)|query-core[\\/](?:.+[\\/])?mutationObserver)\.[cm]?js$/,
    },
  ],
};

export const rendererPlugins = (
  platform: RendererPlatform,
  command: string,
  mode = "production"
): PluginOption[] => {
  const root = webRoot;
  const { release, ...flags } = rendererFlags(command);
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
    compilerReact({ logDiagnostics: true }),
    react({ exclude: [NODE_MODULES, RENDERER_APP_SRC] }),
  ];
};
/**
 * What the browser and Electron renderer configs share. Each adds its own
 * `build` (entries, outDir, sourcemaps); Electron adds its main and preload.
 */
export const rendererConfig = (
  platform: RendererPlatform,
  command: string,
  mode: string
) => ({
  root: webRoot,
  plugins: rendererPlugins(platform, command, mode),
  resolve: {
    alias: rendererAliases(platform),
    dedupe: ["react", "react-dom"],
  },
  worker: { format: "es" as const },
});
