/**
 * `@abacus-ai/agent/tool-display` is imported by the renderer, so its whole
 * import closure must be browser-safe: no `node:` module and no pi (spec
 * §6.1, finding r2-18). This walks the closure from source.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildToolTitle,
  formatToolContent,
  toToolKind,
} from "./tool-display.js";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const NODE_BUILTINS = new Set([
  "fs",
  "path",
  "os",
  "crypto",
  "child_process",
  "net",
  "stream",
  "url",
  "util",
  "readline",
]);

function closure(entry: string): { files: string[]; externals: string[] } {
  const files: string[] = [];
  const externals = new Set<string>();
  const queue = [path.join(SRC, entry)];

  while (queue.length > 0) {
    const file = queue.pop()!;

    if (files.includes(file)) continue;
    files.push(file);

    const source = fs.readFileSync(file, "utf8");

    for (const match of source.matchAll(
      /(?:import|export)[^'"]*?from\s+["']([^"']+)["']/g
    )) {
      const spec = match[1]!;

      if (spec.startsWith(".")) {
        queue.push(
          path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts"))
        );
      } else {
        externals.add(spec);
      }
    }
  }

  return { files, externals: [...externals] };
}

describe("tool-display entry", () => {
  it("imports no node module and no pi, anywhere in its closure", () => {
    const { externals } = closure("tool-display.ts");

    for (const spec of externals) {
      expect(spec.startsWith("node:"), spec).toBe(false);
      expect(NODE_BUILTINS.has(spec), spec).toBe(false);
      expect(spec.includes("pi-"), spec).toBe(false);
    }
    expect(externals).toEqual([]);
  });

  it("titles and kinds from the final input", () => {
    expect(buildToolTitle("bash", { command: "ls -la" })).toBe("Run ls -la");
    expect(buildToolTitle("read", { path: "src/a.ts" })).toBe("Read src/a.ts");
    expect(buildToolTitle("bash", { command: "x".repeat(200) })).toHaveLength(
      80
    );
    expect(toToolKind("grep")).toBe("search");
    expect(toToolKind("edit")).toBe("edit");
    expect(toToolKind("delegate_task")).toBe("think");
    expect(toToolKind("exit_plan_mode")).toBe("switch_mode");
    expect(toToolKind("mystery")).toBe("other");
  });

  it("formats results as markdown", () => {
    expect(
      formatToolContent(
        "bash",
        { content: [{ type: "text", text: "hi" }] },
        false
      )
    ).toBe("```console\nhi\n```");
    expect(formatToolContent("write", { content: [] }, false)).toBe("");
    expect(
      formatToolContent(
        "read",
        { content: [{ type: "text", text: "a```b" }] },
        false
      )
    ).toBe("````\na```b\n````");
    expect(
      formatToolContent(
        "bash",
        { content: [{ type: "text", text: "no" }] },
        true
      )
    ).toBe("```\nno\n```");
  });
});
