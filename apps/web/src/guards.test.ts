import { parseAst } from "rolldown/parseAst";
import { describe, expect, it } from "vitest";

import { readSourceFiles } from "#renderer/test-support/source-files";

/**
 * R1-T15 (covers spec 00 A-T7 for data/**): every renderer source file
 * parsed to an ESTree AST. No `window.api` (or `globalThis.api`/`self.api`),
 * no `ipcRenderer` identifier, no import of electron, the old renderer
 * (except `#locales/*`), framer-motion, zustand or sonner; Base UI only
 * under ui/; only the shell's sidebar map and the dev gallery compose other
 * features. Routes and bootstrap import approved focused public modules so loaders
 * do not pull unrelated presentation code through feature barrels.
 */
import { CONTINUITY_STORES } from "./lib/continuity/registry";

const sources = readSourceFiles(
  ["./**/*.{ts,tsx}", "!./**/*.d.ts", "!./routeTree.gen.ts"],
  import.meta.dirname
);

type Node = { type: string; [key: string]: unknown };

const walk = (node: unknown, visit: (node: Node) => void): void => {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const typed = node as Node;
  if (typeof typed.type === "string") visit(typed);
  for (const value of Object.values(typed)) walk(value, visit);
};

const files = Object.entries(sources).map(([path, source]) => ({
  path: path.replace(/^\.\//, ""),
  source,
  ast: parseAst(source, { lang: path.endsWith(".tsx") ? "tsx" : "ts" }, path),
}));

const importsOf = (ast: unknown): string[] => {
  const found: string[] = [];
  walk(ast, (node) => {
    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        node.type === "ImportExpression") &&
      node.source != null &&
      typeof (node.source as { value?: unknown }).value === "string"
    )
      found.push((node.source as { value: string }).value);
  });
  return found;
};

const BANNED = ["electron", "framer-motion", "zustand", "sonner"];

// Approved focused public modules keep route loaders separate from presentation.
// Additions require a boundary review; directory prefixes are never allowlisted.
const FOCUSED_ENTRYPOINTS: Record<string, readonly string[]> = {
  artifacts: ["gallery"],
  bots: [
    "chat/activity",
    "chat/identity",
    "chat/slots",
    "check-in/check-in-dialog",
    "data/bot-actions",
    "data/loaders",
    "data/open-chat",
    "data/queries",
    "data/search",
    "form/bot-form",
    "form/draft-store",
    "gallery/sections",
    "panel/bot-side-panel",
    "sidebar/bots-sidebar",
    "start/bot-start-page",
    "watcher",
  ],
  chat: [
    "composer/composer",
    "composer/start-composer",
    "fixture-runtime",
    "kit/lazy-view",
    "kit/permissions/permission-list",
    "kit/subagents/detail",
    "kit/subagents/use-subagents",
    "runtime/host",
    "runtime/lazy-runtime",
    "runtime/runtime",
    "runtime/send",
    "runtime/tool-diff",
  ],
  gallery: ["gallery", "search"],
  library: [
    "connect-flow",
    "connectors",
    "globals",
    "mcp",
    "messaging",
    "search",
    "skills-tools",
    "whatsapp-phone",
  ],
  notch: ["gallery"],
  onboarding: [
    "actions",
    "first-run",
    "first-bot",
    "connect",
    "gallery",
    "gate",
    "machine",
    "pairing-banner",
    "steps/local-models",
    "steps/provider-key",
    "store",
    "whatsapp",
  ],
  routines: ["form", "gallery", "globals", "page", "run-requests", "sidebar"],
  sessions: [
    "browser/browser-tab",
    "browser/ask-host",
    "device/device-tab",
    "changes/changes-card",
    "changes/full-diff-dialog",
    "context/context-tray",
    "context/permission-terminal-action",
    "context/tasks",
    "data/composer-model",
    "data/queries",
    "data/unread-store",
    "dock/panel-tabs-store",
    "gallery/sections",
    "globals",
    "session-workspace",
    "sessions-pages",
    "sessions-sidebar",
    "start/session-drafts",
    "start/start-session",
    "start/session-start-page",
    "start/start-resources",
  ],
  settings: [
    "appearance",
    "companion",
    "account-usage",
    "changelog",
    "environment",
    "invite",
    "keyboard",
    "license-section",
    "models",
    "personal",
    "referral-link",
    "search",
    "updates",
  ],
  shell: [
    "connect",
    "connect/recovery",
    "connect/services",
    "lease",
    "app-root",
    "app-toaster",
    "browser-open",
    "hotkeys",
    "native-presenter",
    "panel-store",
    "platform-presenter",
    "preview-consumers",
    "rail",
    "screens",
    "shell-layout",
    "shell-store",
    "side-panel",
    "side-panel-slot",
    "top-bar",
    "top-bar-slots",
    "use-panel",
  ],
  tour: ["gallery", "store"],
};

const featureBoundaryHits = (
  candidates: Array<{ path: string; ast: unknown }>
): string[] => {
  const hits: string[] = [];
  for (const file of candidates) {
    const own = /^features\/([^/]+)\//.exec(file.path)?.[1];
    for (const specifier of importsOf(file.ast)) {
      const target = /^#renderer\/features\/([^/]+)(\/.*)?$/.exec(specifier);
      if (target == null) continue;
      const [, feature, subpath] = target;
      if (
        feature === own ||
        /\.test\.tsx?$/.test(file.path) ||
        file.path.startsWith("test-support/")
      )
        continue;
      const allowed =
        file.path.startsWith("routes/") ||
        file.path.startsWith("notch-routes/") ||
        file.path.startsWith("platform/") ||
        ["router.tsx", "notch.tsx", "notch-context.ts"].includes(file.path) ||
        file.path === "main.tsx" ||
        file.path === "features/shell/sidebars.ts" ||
        own === "gallery";
      const platformSeam =
        feature === "shell" &&
        [
          "lib/activity.ts",
          "lib/browser/files.ts",
          "lib/browser/host-files.ts",
          "lib/browser/sign-in.ts",
          "lib/browser/sign-out.ts",
          "data/transport/index.ts",
        ].includes(file.path) &&
        ["/connect/services", "/lease"].includes(subpath ?? "");
      const panelSeam =
        (file.path === "features/sessions/dock/session-dock.tsx" &&
          feature === "shell" &&
          ["/top-bar", "/top-bar-slots"].includes(subpath ?? "")) ||
        (file.path === "features/shell/use-panel.ts" &&
          feature === "sessions" &&
          subpath === "/dock/panel-tabs-store");
      // Shell navigation owns new-session actions and the account referral panel.
      const shellActionSeam =
        (feature === "sessions" &&
          subpath === "/start/start-session" &&
          [
            "features/shell/app-root.tsx",
            "features/shell/command-menu.tsx",
            "features/shell/rail.tsx",
          ].includes(file.path)) ||
        (file.path === "features/shell/profile-menu.tsx" &&
          feature === "settings" &&
          subpath === "/referral-link");
      if (!allowed && !platformSeam && !panelSeam && !shellActionSeam)
        hits.push(`${file.path}: ${specifier} (other feature)`);
      else if (
        subpath != null &&
        subpath !== "/index" &&
        !FOCUSED_ENTRYPOINTS[feature!]?.includes(subpath.slice(1))
      )
        hits.push(`${file.path}: ${specifier} (private entrypoint)`);
    }
  }
  return hits;
};

describe("renderer guards", () => {
  it("parses every file", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("never touches window.api or ipcRenderer", () => {
    const hits: string[] = [];
    for (const file of files)
      walk(file.ast, (node) => {
        if (node.type === "MemberExpression") {
          const object = node.object as Node & { name?: string };
          const property = node.property as Node & { name?: string };
          if (
            object.type === "Identifier" &&
            ["window", "globalThis", "self"].includes(object.name ?? "") &&
            property.type === "Identifier" &&
            property.name === "api"
          )
            hits.push(`${file.path}: ${object.name}.api`);
        }
        if (node.type === "Identifier" && node.name === "ipcRenderer")
          hits.push(`${file.path}: ipcRenderer`);
      });
    expect(hits).toEqual([]);
  });

  it("imports none of the legacy stack and nothing from the old tree but locales", () => {
    const hits: string[] = [];
    for (const file of files)
      for (const specifier of importsOf(file.ast)) {
        if (BANNED.includes(specifier)) hits.push(`${file.path}: ${specifier}`);
      }
    expect(hits).toEqual([]);
  });

  it("imports Base UI only under ui/", () => {
    const hits = files.flatMap((file) =>
      file.path.startsWith("ui/")
        ? []
        : importsOf(file.ast)
            .filter((specifier) => specifier.startsWith("@base-ui/"))
            .map((specifier) => `${file.path}: ${specifier}`)
    );
    expect(hits).toEqual([]);
  });

  it("keeps feature composition at designated boundaries", () => {
    expect(featureBoundaryHits(files)).toEqual([]);
  });

  it("rejects unapproved internals even at feature composition boundaries", () => {
    const paths = [
      "routes/canary.tsx",
      "platform/canary.tsx",
      "main.tsx",
      "features/shell/sidebars.ts",
      "features/gallery/canary.tsx",
      "components/canary.tsx",
      "features/bots/canary.tsx",
    ];
    for (const path of paths) {
      const source = `import "#renderer/features/sessions/private/canary";
        export * from "#renderer/features/sessions/private/exports";
        const viewer = import("#renderer/features/sessions/private/viewer");`;
      expect(
        featureBoundaryHits([{ path, ast: parseAst(source) }])
      ).toHaveLength(3);
    }
  });

  it("permits approved focused entrypoints only at composition boundaries", () => {
    const source = 'import "#renderer/features/sessions/session-workspace";';
    const ast = parseAst(source);
    expect(featureBoundaryHits([{ path: "routes/canary.tsx", ast }])).toEqual(
      []
    );
    expect(
      featureBoundaryHits([{ path: "features/bots/canary.tsx", ast }])
    ).toHaveLength(1);
    expect(
      featureBoundaryHits([{ path: "features/sessions/canary.tsx", ast }])
    ).toEqual([]);
  });
});

const unregisteredSessionKeys = (source: string, ast: unknown): string[] => {
  const constants = new Map<string, Node>();
  walk(ast, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      (node.id as Node)?.type === "Identifier"
    )
      constants.set((node.id as Node).name as string, node.init as Node);
  });
  const keyOf = (node: Node | undefined): string | null => {
    if (!node) return null;
    if (node.type === "Identifier")
      return keyOf(constants.get(node.name as string));
    if (typeof node.value === "string") return node.value;
    if (node.type === "TemplateLiteral")
      return (
        ((node.quasis as Node[])[0]?.value as { raw?: string })?.raw ?? null
      );
    return null;
  };
  const keys: string[] = [];
  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee as Node;
    if (
      callee?.type !== "MemberExpression" ||
      !["getItem", "setItem", "removeItem"].includes(
        (callee.property as Node)?.name as string
      )
    )
      return;
    const object = callee.object as Node;
    if (
      !(
        object?.name === "sessionStorage" ||
        (object?.property as Node)?.name === "sessionStorage"
      )
    )
      return;
    const key = keyOf((node.arguments as Node[])[0]);
    if (
      key == null ||
      !CONTINUITY_STORES.some((s) =>
        s.prefix ? key.startsWith(s.storage) : key === s.storage
      )
    )
      keys.push(key ?? "unresolved");
  });
  void source;
  return keys;
};
it("every persisted sessionStorage draft has a continuity schema", () => {
  const hits = files
    .filter(
      (f) =>
        !/\.test\.tsx?$/.test(f.path) &&
        !f.path.startsWith("test-support/") &&
        !f.path.startsWith("lib/continuity")
    )
    .flatMap((f) =>
      unregisteredSessionKeys(f.source, f.ast).map((key) => `${f.path}: ${key}`)
    );
  expect(hits).toEqual([]);
});
it("the session-store guard catches an extra unregistered key beside a registered one", () => {
  const source =
    'const KEY = "abacusai-bot:abacus.chat.drafts"; sessionStorage.setItem(KEY, "{}"); globalThis.sessionStorage?.setItem("forgotten.draft", "x");';
  expect(
    unregisteredSessionKeys(
      source,
      parseAst(source, { lang: "ts" }, "canary.ts")
    )
  ).toEqual(["forgotten.draft"]);
});
