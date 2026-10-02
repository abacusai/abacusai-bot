/**
 * A-T7: the renderer's data layer and the contract never touch Electron.
 * They reach main through a Transport only: no `electron` import, no
 * `window.api`, no `ipcRenderer`. Comments and strings may name them (the
 * legacy map has to); code may not.
 *
 * Here rather than beside the transport: it reads the file system, and the
 * renderer-next project compiles without Node's types.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../..");
const SCANNED = ["renderer-next/data", "shared/contract"];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });

/**
 * The code alone: comments dropped, string literals emptied. A small scanner
 * rather than regular expressions, so a quote inside a comment or a URL
 * inside a string cannot throw the pairing off.
 */
const codeOf = (source: string): string => {
  let code = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== char)
        j += source[j] === "\\" ? 2 : 1;
      code += `${char}${char}`;
      i = j + 1;
      continue;
    }
    code += char;
    i += 1;
  }
  return code;
};

const offencesIn = (source: string): string[] => {
  const code = codeOf(source);
  const found: string[] = [];
  // Module specifiers are the only strings that matter.
  const specifiers = [
    ...source.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g
    ),
  ].map((match) => match[1]!);
  if (
    specifiers.some(
      (spec) => spec === "electron" || spec.startsWith("electron/")
    )
  )
    found.push("an electron import");
  if (/\bwindow\s*\.\s*api\b/.test(code)) found.push("window.api");
  if (/\bipcRenderer\b/.test(code)) found.push("ipcRenderer");
  return found;
};

describe("the transport guard (A-T7)", () => {
  const files = SCANNED.flatMap((dir) => walk(join(SRC, dir)));

  it("scans the data layer and the contract", () => {
    expect(files.some((file) => file.includes("renderer-next"))).toBe(true);
    expect(files.length).toBeGreaterThan(20);
  });

  it("finds no Electron in them", () => {
    const offences = files.flatMap((file) =>
      offencesIn(readFileSync(file, "utf8")).map(
        (what) => `${relative(SRC, file)}: ${what}`
      )
    );

    expect(offences).toEqual([]);
  });

  it("would catch one, and ignores comments and strings", () => {
    expect(offencesIn('import { ipcRenderer } from "electron";')).toEqual([
      "an electron import",
      "ipcRenderer",
    ]);
    expect(offencesIn('const m = await import("electron/main");')).toEqual([
      "an electron import",
    ]);
    expect(offencesIn("const x = window.api.agent;")).toEqual(["window.api"]);
    expect(
      offencesIn(
        '// window.api, in a comment\nconst y = "was ipcRenderer.send";\n/* ipcRenderer */'
      )
    ).toEqual([]);
  });
});
