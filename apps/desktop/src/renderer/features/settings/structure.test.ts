import { parseAst } from "rolldown/parseAst";
import { expect, it } from "vitest";
const features = import.meta.glob<string>(
  ["../{routines,artifacts,library,settings}/**/*.{ts,tsx}", "!../**/*.test.*"],
  { query: "?raw", import: "default", eager: true }
);
const components = import.meta.glob<string>(
  "../../components/{form-kit,keymap-editor,sound-preview,artifact-kind,settings-rows,usage-chart}/**/*.{ts,tsx}",
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
          id.startsWith("#renderer/features/") ||
          /(?:^|\/)main\//.test(id) ||
          id === "electron" ||
          id === "qrcode" ||
          /(?:monaco|recharts|chart.js|cron-parser|croner)/.test(id)
        )
          failures.push(`${path}: ${id}`);
        if (path.includes("/components/") && id.startsWith("#renderer/data/"))
          failures.push(`${path}: data import ${id}`);
      }
      const property = (value: unknown): string | undefined => {
        if (!value || typeof value !== "object") return;
        const member = value as Record<string, unknown>;
        if (member.type === "MemberExpression")
          return String((member.property as { name?: string }).name);
        if (member.type === "Identifier") return String(member.name);
      };
      const errorValue = (value: unknown) =>
        ["message", "lastResult", "reason", "errorMessage"].includes(
          property(value) ?? ""
        );
      if (
        node.type === "MemberExpression" &&
        property(node) === "api" &&
        property(node.object) === "window"
      )
        failures.push(`${path}: window.api`);
      // Typed file-result discriminants are part of the contract, not error copy.
      const typedFileReason =
        path.endsWith("/artifacts/data.ts") &&
        ["not-a-file", "missing"].some(
          (value) =>
            (property(node.left) === "reason" &&
              (node.right as { value?: unknown })?.value === value) ||
            (property(node.right) === "reason" &&
              (node.left as { value?: unknown })?.value === value)
        );
      if (
        node.type === "BinaryExpression" &&
        ["===", "==", "!==", "!="].includes(String(node.operator)) &&
        (errorValue(node.left) || errorValue(node.right)) &&
        !typedFileReason
      )
        failures.push(`${path}: error-text equality`);
      if (node.type === "CallExpression") {
        const call = node.callee as Record<string, unknown>;
        const method = property(call);
        if (
          (["includes", "match", "search"].includes(method ?? "") &&
            errorValue(call.object)) ||
          (method === "test" && (node.arguments as unknown[]).some(errorValue))
        )
          failures.push(`${path}: error-text pattern`);
      }
      for (const child of Object.values(node)) walk(child);
    };
    walk(file);
  }
  expect(Object.keys(features).length).toBeGreaterThan(20);
  expect(Object.keys(components).length).toBeGreaterThan(3);
  expect(failures).toEqual([]);
});
