/** R3-T11,T21,T29,T30: boundaries, parity destinations and mapped locale sources. */
const { existsSync } = (
  globalThis as unknown as {
    process: {
      getBuiltinModule(id: "node:fs"): {
        existsSync(path: string): boolean;
        readFileSync(path: string, encoding: "utf8"): string;
      };
    };
  }
).process.getBuiltinModule("node:fs");

import { parseAst } from "rolldown/parseAst";
import { describe, expect, it } from "vitest";

import { BOT_PARITY } from "./parity";
const sources = import.meta.glob<string>(
  ["./**/*.{ts,tsx}", "!./**/*.test.*"],
  { query: "?raw", import: "default", eager: true }
);
const molecules = import.meta.glob<string>(
  [
    "../../components/bot-avatar/**/*.{ts,tsx}",
    "../../components/connector-mark/**/*.{ts,tsx}",
    "../../components/bot-memory-list/**/*.{ts,tsx}",
    "../../components/file-preview/**/*.{ts,tsx}",
    "../../components/connector-request-card/**/*.{ts,tsx}",
    "!../../components/**/*.test.*",
  ],
  { query: "?raw", import: "default", eager: true }
);
const visit = (
  value: unknown,
  fn: (node: Record<string, unknown>) => void
): void => {
  if (Array.isArray(value)) {
    for (const child of value) visit(child, fn);
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  if (typeof node.type === "string") fn(node);
  for (const child of Object.values(node)) visit(child, fn);
};
const imports = (source: string, path: string): string[] => {
  const out: string[] = [];
  visit(
    parseAst(source, { lang: path.endsWith("tsx") ? "tsx" : "ts" }),
    (node) => {
      if (
        [
          "ImportDeclaration",
          "ExportNamedDeclaration",
          "ExportAllDeclaration",
        ].includes(String(node.type)) &&
        node.source
      )
        out.push(String((node.source as { value: string }).value));
    }
  );
  return out;
};
describe("bots architecture", () => {
  it("features only use their own feature and renderer layers", () => {
    for (const [path, source] of Object.entries(sources))
      for (const specifier of imports(source, path)) {
        expect(specifier, path).not.toMatch(
          /^#next\/features\/(?!bots(?:\/|$))/u
        );
        expect(specifier, path).not.toMatch(/@dicebear|@lobehub|^uuid$/u);
      }
  });
  it("molecules import no collections or features", () => {
    for (const [path, source] of Object.entries(molecules))
      for (const specifier of imports(source, path))
        expect(specifier, path).not.toMatch(/^#next\/(?:features|data)\//u);
  });
  it("bot actions branch on codes rather than error message strings", () => {
    for (const [path, source] of Object.entries(sources))
      if (!path.endsWith("connector-requests.ts"))
        expect(source, path).not.toMatch(/\.message(?:\s*===|\.includes\()/u);
  });
  it("all 73 parity rows have an existing target and explicit status", () => {
    expect(BOT_PARITY.map((row) => row.id)).toEqual(
      Array.from({ length: 73 }, (_, i) => `P${i + 1}`)
    );
    for (const row of BOT_PARITY) {
      expect(existsSync(`src/renderer/${row.target}`), row.id).toBe(true);
      expect(row.status).toBeTruthy();
    }
  });
});
