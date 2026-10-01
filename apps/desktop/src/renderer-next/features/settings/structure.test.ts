import { parseAst } from "rolldown/parseAst";
import { expect, it } from "vitest";
const features = import.meta.glob<string>(
  ["../{routines,artifacts,library,settings}/**/*.{ts,tsx}", "!../**/*.test.*"],
  { query: "?raw", import: "default", eager: true }
);
const components = import.meta.glob<string>(
  "../../components/{form-kit,keymap-editor,sound-preview}/**/*.{ts,tsx}",
  { query: "?raw", import: "default", eager: true }
);
it("R5-T11,T37 owned feature and molecule imports preserve the dependency boundaries", () => {
  const failures: string[] = [];
  for (const [path, source] of Object.entries({ ...features, ...components })) {
    const file = parseAst(source, {
      lang: path.endsWith("tsx") ? "tsx" : "ts",
    });
    const walk = (value: unknown) => {
      if (Array.isArray(value)) {
        for (const child of value) walk(child);
        return;
      }
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (
        [
          "ImportDeclaration",
          "ExportNamedDeclaration",
          "ExportAllDeclaration",
        ].includes(String(node.type)) &&
        node.source
      ) {
        const id = String((node.source as { value: string }).value);
        if (
          id.startsWith("#next/features/") ||
          /(?:^|\/)main\//.test(id) ||
          id === "electron"
        )
          failures.push(`${path}: ${id}`);
        if (path.includes("/components/") && id.startsWith("#next/data/"))
          failures.push(`${path}: data import ${id}`);
      }
      for (const child of Object.values(node)) walk(child);
    };
    walk(file);
  }
  expect(Object.keys(features).length).toBeGreaterThan(20);
  expect(Object.keys(components).length).toBeGreaterThan(3);
  expect(failures).toEqual([]);
});
