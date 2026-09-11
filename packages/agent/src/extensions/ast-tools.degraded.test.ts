/**
 * What the two structural tools do when the ground gives way.
 *
 * ast-grep is an optional native dependency (see lang.ts): its ABI has to match
 * the Node the agent runs under, which a desktop app cannot promise on every
 * platform it ships to. So there is a real, shipped configuration in which the
 * parser is simply absent — and the whole design of these tools rests on what
 * they do then. `ast_edit` silently doing nothing would look like a successful
 * edit, and `code_map` reporting "no symbols" would look like an empty file.
 * Both have to refuse, and say why.
 *
 * That path cannot be reached by giving the tools different inputs, only by
 * taking the parser away, which is what the mock here does. The same goes for a
 * parser that throws on one file: it does not happen on any real file in the
 * corpus, and the handling still has to be right, because "one file broke" must
 * not become "the scan returned nothing".
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fakePi, type FakePi } from "@abacus-ai/test-support/fake-pi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
}

type Execute = (
  id: string,
  params: unknown,
  signal: undefined,
  onUpdate: undefined,
  ctx: { cwd: string }
) => Promise<ToolResult>;

let cwd: string;

const textOf = (result: ToolResult): string =>
  result.content.map((part) => part.text).join("\n");

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ast-degraded-"));
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
  vi.doUnmock("../lang.js");
  vi.doUnmock("../symbols.js");
});

describe("a build with no ast-grep parser", () => {
  async function toolsWithoutParser(): Promise<FakePi> {
    vi.doMock("../lang.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../lang.js")>()),
      astGrepAvailable: () => false,
    }));

    const { default: astTools } = await import("./ast-tools.js");
    const pi = fakePi();
    astTools(pi.api as never);

    return pi;
  }

  it("has ast_edit refuse rather than report a successful no-op", async () => {
    fs.writeFileSync(path.join(cwd, "a.ts"), "console.log(1)");
    const pi = await toolsWithoutParser();

    const result = await (
      pi.tools.get("ast_edit")!.execute as unknown as Execute
    )(
      "call-1",
      { path: "a.ts", pattern: "console.log($A)", rewrite: "x($A)" },
      undefined,
      undefined,
      { cwd }
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no ast-grep parser");
    // The advice matters as much as the refusal: it names the tool to use next.
    expect(textOf(result)).toContain("Use edit instead");
    expect(fs.readFileSync(path.join(cwd, "a.ts"), "utf8")).toBe(
      "console.log(1)"
    );
  });

  it("has code_map refuse rather than report an empty workspace", async () => {
    fs.writeFileSync(path.join(cwd, "a.ts"), "export function present() {}");
    const pi = await toolsWithoutParser();

    const result = await (
      pi.tools.get("code_map")!.execute as unknown as Execute
    )("call-1", {}, undefined, undefined, { cwd });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("no ast-grep parser");
    expect(textOf(result)).toContain("Use grep or glob instead");
    // Emphatically NOT the sentence a genuinely empty directory would produce.
    expect(textOf(result)).not.toContain("No symbols found");
  });
});

describe("a parser that throws on one file", () => {
  it("loses that file and keeps the rest", async () => {
    // No file in the 7,000-file corpus provokes this, and the handling still has
    // to be right: a scan that gave up on the first awkward file would report a
    // repository as empty.
    const { symbolsIn: realSymbolsIn } = await import("../symbols.js");

    vi.doMock("../symbols.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../symbols.js")>()),
      symbolsIn: (family: never, source: string, root: never) => {
        if (source.includes("EXPLODE")) throw new Error("parser blew up");

        return realSymbolsIn(family, source, root);
      },
    }));

    const { default: astTools } = await import("./ast-tools.js");
    const pi = fakePi();
    astTools(pi.api as never);

    fs.mkdirSync(path.join(cwd, "src"));
    fs.writeFileSync(
      path.join(cwd, "src", "a-bad.ts"),
      "export function EXPLODE() {}"
    );
    fs.writeFileSync(
      path.join(cwd, "src", "b-good.ts"),
      "export function survivor() {}"
    );

    const result = await (
      pi.tools.get("code_map")!.execute as unknown as Execute
    )("call-1", {}, undefined, undefined, { cwd });

    expect(textOf(result)).toContain("survivor()");
    expect(textOf(result)).toContain("1 file(s) could not be read or parsed");
  });
});
