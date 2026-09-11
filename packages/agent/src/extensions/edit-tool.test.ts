/**
 * The edit tool writes to disk, so these drive it against real files in a temp
 * directory rather than a mocked filesystem: the things most likely to break —
 * a CRLF file silently converted to LF, a BOM dropped, a `$&` in the
 * replacement mangled — are all invisible to a mock that only tracks strings.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fakePi, type FakeTool } from "@abacus-ai/test-support/fake-pi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { astGrepAvailable } from "../lang.js";
import editTool from "./edit-tool.js";

let cwd: string;
let tool: FakeTool;
let batchTool: FakeTool;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "edit-tool-"));
  const pi = fakePi();
  editTool(pi.api as never);
  tool = pi.tools.get("edit")!;
  batchTool = pi.tools.get("batch_edit")!;
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

/** Write a fixture and return the relative path the tool is given. */
function fixture(name: string, content: string): string {
  fs.writeFileSync(path.join(cwd, name), content);
  return name;
}

function read(name: string): string {
  return fs.readFileSync(path.join(cwd, name), "utf8");
}

type Edit = { oldText: string; newText: string; replaceAll?: boolean };

/**
 * Apply edits the way a model would: one change goes to `edit` as plain
 * arguments, several go to `batch_edit`. Routing on the count keeps every
 * existing case exercising whichever tool actually owns that shape.
 */
async function edit(file: string, edits: Edit[]) {
  if (edits.length === 1) {
    return tool.execute(
      "call-1",
      { path: file, ...edits[0] },
      undefined,
      undefined,
      { cwd }
    );
  }
  return batchTool.execute(
    "call-1",
    { path: file, edits },
    undefined,
    undefined,
    { cwd }
  );
}

/** The tool's text output, for asserting on the message the model will read. */
function textOf(result: Awaited<ReturnType<typeof edit>>): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("the tools register the way pi expects", () => {
  it("claims the name `edit`, replacing the built-in", () => {
    expect(tool.name).toBe("edit");
  });

  it("registers batch_edit alongside it", () => {
    expect(batchTool.name).toBe("batch_edit");
  });

  it("gives edit plain oldText/newText arguments, not an array", () => {
    const schema = JSON.stringify(tool.parameters);
    expect(schema).toContain("oldText");
    expect(schema).toContain("replaceAll");
    // The one-change case must not have to wrap itself in a list.
    expect(schema).not.toContain("edits");
  });

  it("gives batch_edit the array, and not the flat arguments", () => {
    const schema = JSON.stringify(batchTool.parameters);
    expect(schema).toContain("edits");
    expect(JSON.parse(schema).properties.oldText).toBeUndefined();
  });

  it("points each tool at the other, so the model can pick", () => {
    expect(tool.description).toContain("batch_edit");
    expect(batchTool.description).toContain("edit");
  });
});

describe("applying edits", () => {
  it("replaces one span", async () => {
    const file = fixture("a.ts", "const a = 1\nconst b = 2\n");
    const result = await edit(file, [
      { oldText: "const b = 2", newText: "const b = 3" },
    ]);

    expect(result.isError).toBeFalsy();
    expect(read(file)).toBe("const a = 1\nconst b = 3\n");
  });

  it("applies several disjoint edits in one call", async () => {
    const file = fixture("a.ts", "one\ntwo\nthree\n");
    await edit(file, [
      { oldText: "one", newText: "1" },
      { oldText: "three", newText: "3" },
    ]);

    expect(read(file)).toBe("1\ntwo\n3\n");
  });

  it("matches every edit against the original, not against earlier results", async () => {
    // If edits were applied cumulatively, the second would find the `b` the
    // first just wrote and produce `c`.
    const file = fixture("a.ts", "a\nb\n");
    await edit(file, [
      { oldText: "a", newText: "b" },
      { oldText: "b", newText: "c" },
    ]);

    expect(read(file)).toBe("b\nc\n");
  });

  it("reports what it did", async () => {
    const file = fixture("a.ts", "x = 1\n");
    const result = await edit(file, [{ oldText: "x = 1", newText: "x = 2" }]);

    expect(textOf(result)).toContain("a.ts");
  });

  it("returns the diff details the desktop and TUI render", async () => {
    const file = fixture("a.ts", "x = 1\n");
    const result = await edit(file, [{ oldText: "x = 1", newText: "x = 2" }]);
    const details = result.details as {
      diff: string;
      patch: string;
      firstChangedLine?: number;
    };

    expect(details.diff).toBeTruthy();
    expect(details.patch).toContain("x = 2");
    expect(details.firstChangedLine).toBe(1);
  });
});

describe("replaceAll", () => {
  it("changes every occurrence when asked", async () => {
    const file = fixture("a.ts", "log(1)\nlog(2)\nlog(3)\n");
    const result = await edit(file, [
      { oldText: "log(", newText: "trace(", replaceAll: true },
    ]);

    expect(result.isError).toBeFalsy();
    expect(read(file)).toBe("trace(1)\ntrace(2)\ntrace(3)\n");
  });

  it("refuses an ambiguous edit without it, and says the flag exists", async () => {
    const file = fixture("a.ts", "log(1)\nlog(2)\n");
    const result = await edit(file, [{ oldText: "log(", newText: "trace(" }]);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("replaceAll");
    // Nothing was written.
    expect(read(file)).toBe("log(1)\nlog(2)\n");
  });

  it("stops listing clashing lines once there are too many to be useful", async () => {
    const file = fixture(
      "a.ts",
      Array.from({ length: 14 }, () => "log(1)").join("\n")
    );
    const result = await edit(file, [{ oldText: "log(1)", newText: "y" }]);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("matches 14 places");
    // The first ten, then an ellipsis rather than a wall of numbers.
    expect(textOf(result)).toContain("…");
  });

  it("names the lines that clash, so the model can add context instead", async () => {
    const file = fixture("a.ts", "log(1)\nx\nlog(1)\n");
    const result = await edit(file, [{ oldText: "log(1)", newText: "y" }]);

    expect(textOf(result)).toContain("lines 1, 3");
  });

  it("still works when there is only one occurrence", async () => {
    const file = fixture("a.ts", "log(1)\n");
    await edit(file, [
      { oldText: "log(", newText: "trace(", replaceAll: true },
    ]);

    expect(read(file)).toBe("trace(1)\n");
  });
});

describe("refusing edits it cannot apply safely", () => {
  it("rejects overlapping edits rather than silently dropping one", async () => {
    const file = fixture("a.ts", "abcdef\n");
    const result = await edit(file, [
      { oldText: "abcd", newText: "X" },
      { oldText: "cdef", newText: "Y" },
    ]);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("overlap");
    expect(read(file)).toBe("abcdef\n");
  });

  it("rejects an empty edits array", async () => {
    const file = fixture("a.ts", "x\n");
    const result = await batchTool.execute(
      "c",
      { path: file, edits: [] },
      undefined,
      undefined,
      {
        cwd,
      }
    );

    expect(result.isError).toBe(true);
  });

  it("rejects an edit that would change nothing", async () => {
    const file = fixture("a.ts", "x = 1\n");
    const result = await edit(file, [{ oldText: "x = 1", newText: "x = 1" }]);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("nothing");
  });

  it("points at write when the file does not exist", async () => {
    const result = await edit("missing.ts", [{ oldText: "a", newText: "b" }]);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("write");
  });

  it("refuses a directory", async () => {
    fs.mkdirSync(path.join(cwd, "sub"));
    const result = await edit("sub", [{ oldText: "a", newText: "b" }]);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("directory");
  });

  it("refuses a binary file rather than corrupting it", async () => {
    fs.writeFileSync(
      path.join(cwd, "blob.bin"),
      Buffer.from([0x41, 0x00, 0x42])
    );
    const result = await edit("blob.bin", [{ oldText: "A", newText: "C" }]);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("binary");
  });

  it("points at write when oldText is empty", async () => {
    const file = fixture("a.ts", "const a = 1\n");
    const result = await edit(file, [{ oldText: "", newText: "x" }]);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("write");
    expect(read(file)).toBe("const a = 1\n");
  });

  it("refuses a loose match that would swallow far more than was asked for", async () => {
    // Same tokens and line count, but the file's copy carries a three-thousand
    // character whitespace run. Splicing over all of it for a seven-character
    // quote is not a repair, it is data loss.
    const file = fixture("a.ts", `a${" ".repeat(3_000)}b\nc d\n`);
    const result = await edit(file, [{ oldText: "a b\nc d", newText: "z" }]);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("too much to replace safely");
    expect(read(file)).toBe(`a${" ".repeat(3_000)}b\nc d\n`);
  });

  it("says so plainly when the text is nowhere in the file", async () => {
    const file = fixture("a.ts", "const a = 1\n");
    const result = await edit(file, [
      { oldText: "const zzz = 9", newText: "x" },
    ]);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Re-read");
  });
});

describe("preserving what it did not mean to change", () => {
  it("keeps CRLF line endings", async () => {
    const file = fixture("a.ts", "const a = 1\r\nconst b = 2\r\n");
    await edit(file, [{ oldText: "const b = 2", newText: "const b = 3" }]);

    expect(read(file)).toBe("const a = 1\r\nconst b = 3\r\n");
  });

  it("matches text the model quoted with LF against a CRLF file", async () => {
    const file = fixture("a.ts", "a\r\nb\r\nc\r\n");
    const result = await edit(file, [{ oldText: "a\nb", newText: "a\nB" }]);

    expect(result.isError).toBeFalsy();
    expect(read(file)).toBe("a\r\nB\r\nc\r\n");
  });

  it("keeps a byte-order mark", async () => {
    const file = fixture("a.ts", "﻿const a = 1\n");
    await edit(file, [{ oldText: "const a = 1", newText: "const a = 2" }]);

    expect(read(file)).toBe("﻿const a = 2\n");
  });

  it("writes a dollar sign literally, where String.replace would expand it", async () => {
    const file = fixture("a.ts", 'const s = ""\n');
    await edit(file, [{ oldText: '""', newText: '"$& $1 $\'"' }]);

    expect(read(file)).toBe('const s = "$& $1 $\'"\n');
  });

  it("leaves the file untouched when any edit in the batch fails", async () => {
    const file = fixture("a.ts", "one\ntwo\n");
    const result = await edit(file, [
      { oldText: "one", newText: "1" },
      { oldText: "nowhere", newText: "x" },
    ]);

    expect(result.isError).toBe(true);
    expect(read(file)).toBe("one\ntwo\n");
  });
});

describe("recovering from a near-miss, end to end", () => {
  it("applies an edit whose indentation was wrong", async () => {
    const file = fixture("a.ts", "function f() {\n  return 1\n}\n");
    const result = await edit(file, [
      { oldText: "    return 1", newText: "    return 2" },
    ]);

    expect(result.isError).toBeFalsy();
    expect(read(file)).toBe("function f() {\n    return 2\n}\n");
  });

  it("tells the model when it had to match loosely", async () => {
    const file = fixture("a.ts", "function f() {\n  return 1\n}\n");
    const result = await edit(file, [
      { oldText: "    return 1", newText: "    return 2" },
    ]);

    expect(textOf(result)).toContain("matched");
  });
});

describe("the syntax gate on a widened edit", () => {
  const canParse = astGrepAvailable();

  it.skipIf(!canParse)(
    "refuses a replaceAll that would break the file",
    async () => {
      const file = fixture("a.ts", "f(1)\nf(2)\nf(3)\n");
      // Dropping the closing paren everywhere leaves the file unparseable.
      const result = await edit(file, [
        { oldText: ")", newText: "", replaceAll: true },
      ]);

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("unchanged");
      expect(read(file)).toBe("f(1)\nf(2)\nf(3)\n");
    }
  );

  it.skipIf(!canParse)(
    "quotes the broken snippet instead of wrapping it in parens",
    async () => {
      // Broken code so often ends in an unclosed bracket that a parenthesised
      // snippet closes itself on screen: `f(1` was rendering as `f(1)`, which
      // reads as perfectly valid code and hides the actual fault.
      const file = fixture("a.ts", "f(1)\nf(2)\n");
      const result = await edit(file, [
        { oldText: ")", newText: "", replaceAll: true },
      ]);

      expect(textOf(result)).toContain('"f(1"');
    }
  );

  it.skipIf(!canParse)(
    "allows a replaceAll that keeps the file valid",
    async () => {
      const file = fixture("a.ts", "f(1)\nf(2)\n");
      const result = await edit(file, [
        { oldText: "f(", newText: "g(", replaceAll: true },
      ]);

      expect(result.isError).toBeFalsy();
      expect(read(file)).toBe("g(1)\ng(2)\n");
    }
  );

  it("lets a single edit through even mid-refactor, where a broken state is normal", async () => {
    const file = fixture("a.ts", "function f() {\n  return 1\n}\n");
    // syntax-check appends a warning to results like this; the edit itself
    // must not be refused, or a two-step refactor could never take its first
    // step.
    const result = await edit(file, [
      { oldText: "function f() {", newText: "function f() { (" },
    ]);

    expect(result.isError).toBeFalsy();
    expect(read(file)).toContain("function f() { (");
  });

  it("does not gate a file type it cannot parse", async () => {
    const file = fixture("notes.txt", "a(\na(\n");
    const result = await edit(file, [
      { oldText: "a(", newText: "b(", replaceAll: true },
    ]);

    expect(result.isError).toBeFalsy();
    expect(read(file)).toBe("b(\nb(\n");
  });
});

/**
 * The paths that only happen when something goes wrong. They matter more than
 * their frequency suggests: an unreadable file or a failed write has to come
 * back as a message the model can act on, not as an exception that kills the
 * turn.
 */
describe("when the filesystem says no", () => {
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  // chmod cannot make a path unreadable on Windows, any more than it can as root.
  const cannotDenyReads = asRoot || process.platform === "win32";

  it.skipIf(cannotDenyReads)(
    "reports an unreadable file rather than throwing",
    async () => {
      const file = fixture("locked.ts", "const a = 1\n");
      fs.chmodSync(path.join(cwd, file), 0o000);

      const result = await edit(file, [
        { oldText: "const a = 1", newText: "const a = 2" },
      ]);
      fs.chmodSync(path.join(cwd, file), 0o644);

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Cannot read");
    }
  );

  it.skipIf(asRoot)(
    "reports an unwritable file rather than throwing",
    async () => {
      const file = fixture("readonly.ts", "const a = 1\n");
      fs.chmodSync(path.join(cwd, file), 0o444);

      const result = await edit(file, [
        { oldText: "const a = 1", newText: "const a = 2" },
      ]);
      fs.chmodSync(path.join(cwd, file), 0o644);

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Cannot write");
      // The file is untouched, which is the point of reporting rather than throwing.
      expect(read(file)).toBe("const a = 1\n");
    }
  );
});

/**
 * A relaxed match can land on text that already reads the way the model wants
 * it to. The edit then changes nothing, and saying so is better than reporting
 * a success the diff will not show.
 */
describe("an edit that turns out to be a no-op", () => {
  it("says the result was identical rather than claiming a change", async () => {
    // oldText is over-indented, so it matches loosely — onto text that already
    // equals newText.
    const file = fixture("a.ts", "function f() {\n  return 1\n}\n");
    const result = await edit(file, [
      { oldText: "    return 1", newText: "  return 1" },
    ]);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("identical");
    expect(read(file)).toBe("function f() {\n  return 1\n}\n");
  });
});

/**
 * The TUI renderers are borrowed from pi's built-in, which expects the batch
 * shape. `edit` hands them a flat call, so the adapter is the one piece of that
 * borrowing which is ours to get wrong.
 */
describe("rendering a flat edit through the borrowed renderers", () => {
  it("adapts a flat call into the batch shape the renderers expect", () => {
    // pi's theme is a broad surface and modelling it here would test pi, not
    // us. Anything the renderer reaches for resolves to a passthrough, so what
    // this exercises is our own flat-to-batch adaptation.
    const theme = new Proxy(
      {},
      {
        get:
          () =>
          (...args: unknown[]) =>
            args[args.length - 1],
      }
    ) as never;
    const context = { state: {}, args: {} } as never;

    expect(() =>
      tool.renderCall?.(
        { path: "a.ts", oldText: "a", newText: "b" } as never,
        theme,
        context
      )
    ).not.toThrow();
  });
});
