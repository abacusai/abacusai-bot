import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseAst } from "rolldown/parseAst";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
  (file) =>
    file.endsWith(".ts") && !file.includes(".test.") && !file.includes("e2e-")
);

type Node = {
  type?: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
};
const calls = (
  source: string,
  visit: (name: string, node: Node, parents: Node[]) => void
) => {
  const walk = (value: unknown, parents: Node[]): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, parents);
      return;
    }
    const node = value as Node;
    if (node.type === "CallExpression") {
      const callee = node.callee as Node;
      if (callee.type === "MemberExpression") {
        const name = (callee.property as { name?: string }).name;
        if (name) visit(name, node, parents);
      }
    }
    for (const child of Object.values(node))
      walk(child, node.type ? [...parents, node] : parents);
  };
  walk(parseAst(source, { lang: "ts" }), []);
};
it("R6-T29 every production native-window enumeration explicitly excludes the companion", () => {
  const enumerations: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    calls(source, (name, _node, parents) => {
      if (!["getAllWindows", "getFocusedWindow"].includes(name)) return;
      enumerations.push(file);
      const statement = parents.findLast(
        (node) =>
          node.type === "VariableDeclaration" ||
          node.type === "ExpressionStatement"
      );
      expect(source.slice(statement?.start, statement?.end), file).toContain(
        "isNotchWindow"
      );
    });
  }
  expect(enumerations).toHaveLength(3);
});
it("R6-T29 production renderer trust is registered only in the two main wiring functions", () => {
  const registrations: string[] = [];
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    calls(source, (name, node) => {
      if (name !== "registerRendererContents") return;
      registrations.push(file);
      const kind = (node.arguments as { value?: string }[])[1]?.value;
      expect(["main", "notch"]).toContain(kind);
    });
  }
  expect(registrations).toEqual(["index.ts", "index.ts"]);
});
