import { readFileSync } from "node:fs";

import { parseAst } from "rolldown/parseAst";
import { expect, it } from "vitest";

// Acceptance gates must not bypass the controls they claim to exercise.
it("the real-session Electron gate uses session actions only through rendered controls", () => {
  const source = readFileSync(
    new URL("./chat-real-session.electron.test.ts", import.meta.url),
    "utf8"
  );
  const ast = parseAst(source, { lang: "ts" });
  const bypasses: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value == null || typeof value !== "object") return;
    const node = value as Record<string, any>;
    if (node.type === "TemplateLiteral") {
      node.expressions.forEach(
        (expression: Record<string, unknown>, i: number) => {
          if (expression.type !== "Identifier" || expression.name !== "session")
            return;
          const tail = node.quasis[i + 1].value.cooked as string;
          const call = /^\.(submit|enqueue|respondPermission|cancel)\s*\(/.exec(
            tail
          );
          if (call) bypasses.push(call[1]!);
        }
      );
    }
    Object.values(node).forEach(visit);
  };
  visit(ast);
  expect(bypasses).toEqual([]);
});
