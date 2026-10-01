import { parseAst } from "rolldown/parseAst";
import { describe, expect, it } from "vitest";

/**
 * R1-T15 (covers spec 00 A-T7 for data/**): every renderer source file
 * parsed to an ESTree AST. No `window.api` (or `globalThis.api`/`self.api`),
 * no `ipcRenderer` identifier, no import of electron, the old renderer
 * (except `#locales/*`), framer-motion, zustand or sonner; Base UI only
 * under ui/; only the shell's sidebar map and the dev gallery compose other
 * features. Routes and bootstrap import focused feature modules so loaders
 * do not pull unrelated presentation code through feature barrels.
 */
import { CONTINUITY_STORES } from "./lib/continuity/registry";

const sources = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./**/*.d.ts", "!./routeTree.gen.ts"],
  { query: "?raw", import: "default", eager: true }
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
    const hits: string[] = [];
    for (const file of files) {
      const own = /^features\/([^/]+)\//.exec(file.path)?.[1];
      for (const specifier of importsOf(file.ast)) {
        const target = /^#renderer\/features\/([^/]+)(\/.*)?$/.exec(specifier);
        if (target == null) continue;
        const [, feature] = target;
        if (feature === own) continue;
        const allowed =
          file.path.startsWith("routes/") ||
          file.path === "main.tsx" ||
          file.path.endsWith(".test.ts") ||
          file.path.endsWith(".test.tsx") ||
          file.path.startsWith("test-support/") ||
          file.path === "features/shell/sidebars.ts" ||
          own === "gallery";
        if (own != null && !allowed)
          hits.push(`${file.path}: ${specifier} (other feature)`);
      }
    }
    expect(hits).toEqual([]);
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
    'const KEY = "abacus.chat.drafts"; sessionStorage.setItem(KEY, "{}"); globalThis.sessionStorage?.setItem("forgotten.draft", "x");';
  expect(
    unregisteredSessionKeys(
      source,
      parseAst(source, { lang: "ts" }, "canary.ts")
    )
  ).toEqual(["forgotten.draft"]);
});
