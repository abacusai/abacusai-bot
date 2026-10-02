import { parseAst } from "rolldown/parseAst";
import { expect, it } from "vitest";

import { readSourceFiles } from "#renderer/test-support/source-files";

const sources = readSourceFiles(
  [
    "/src/renderer/features/{notch,onboarding,tour}/**/*.{ts,tsx}",
    "/src/renderer/lib/voice/*.{ts,tsx}",
    "!/src/renderer/**/*.test.{ts,tsx}",
  ],
  import.meta.dirname
);

type Node = { type?: string; [key: string]: unknown };
const walk = (value: unknown, visit: (node: Node) => void): void => {
  if (!value || typeof value !== "object") return;
  const node = value as Node;
  if (node.type) visit(node);
  for (const child of Object.values(node)) walk(child, visit);
};

it("R6-T38/T39 phase-6 code stays on typed transport and imports no retired UI stack", () => {
  const forbidden: string[] = [];
  expect(Object.keys(sources).length).toBeGreaterThan(20);
  for (const [path, source] of Object.entries(sources)) {
    walk(
      parseAst(source, { lang: path.endsWith(".tsx") ? "tsx" : "ts" }),
      (node) => {
        if (
          node.type === "ImportDeclaration" ||
          node.type === "ImportExpression"
        ) {
          const specifier = (node.source as { value?: string })?.value ?? "";
          if (
            [
              "electron",
              "react-tourlight",
              "canvas-confetti",
              "@tsparticles/react",
              "@tsparticles/engine",
            ].includes(specifier)
          )
            forbidden.push(`${path}: ${specifier}`);
          if (
            path.includes("/notch/") &&
            /features\/shell|lib\/window-chrome/.test(specifier)
          )
            forbidden.push(`${path}: ${specifier}`);
        }
        if (node.type === "MemberExpression") {
          const object = node.object as Node;
          const property = node.property as Node;
          if (object.name === "window" && property.name === "api")
            forbidden.push(`${path}: window.api`);
          if (object.name === "ai" && property.name === "send")
            forbidden.push(`${path}: ai.send`);
          if (object.name === "agent" && property.name === "respondPermission")
            forbidden.push(`${path}: agent.respondPermission`);
        }
      }
    );
  }
  expect(forbidden).toEqual([]);
});
