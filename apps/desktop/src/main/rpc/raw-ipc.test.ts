import fs from "node:fs";
import path from "node:path";

import { parseSync } from "oxc-parser";
import { expect, it } from "vitest";
it("R7-T20 only the MessagePort connection installs raw IPC", () => {
  const hits: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (file.endsWith(".ts") && !file.endsWith(".test.ts")) {
        const ast = parseSync(file, fs.readFileSync(file, "utf8"));
        const walk = (value: unknown): void => {
          if (!value || typeof value !== "object") return;
          const node = value as {
            type?: string;
            callee?: {
              object?: { name?: string };
              property?: { name?: string };
            };
            arguments?: { name?: string }[];
          };
          if (
            node.type === "CallExpression" &&
            node.callee?.object?.name === "ipcMain" &&
            ["on", "handle"].includes(node.callee.property?.name ?? "")
          ) {
            expect(node.arguments?.[0]?.name, file).toBe("RPC_CONNECT_CHANNEL");
            hits.push(
              path.relative(path.join(import.meta.dirname, ".."), file)
            );
          }
          for (const child of Object.values(value))
            if (Array.isArray(child)) child.forEach(walk);
            else walk(child);
        };
        walk(ast.program);
      }
    }
  };
  visit(path.join(import.meta.dirname, ".."));
  expect(hits).toEqual(["rpc/transports/message-port.ts"]);
});
