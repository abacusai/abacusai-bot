/**
 * A batch read is a context-window risk before it is anything else: twenty
 * files at one file's budget is twenty times the output, and the compaction
 * that follows throws away the very thing the model was reading. So most of
 * these tests are about the budget holding and about one bad path not costing
 * the model the other nine.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fakePi, type FakeTool } from "@abacus-ai/test-support/fake-pi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import batchReadTool from "./batch-read-tool.js";

let cwd: string;
let tool: FakeTool;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "batch-read-"));
  const pi = fakePi();
  batchReadTool(pi.api as never);
  tool = pi.tools.get("batch_file_read")!;
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function fixture(name: string, content: string): string {
  fs.writeFileSync(path.join(cwd, name), content);
  return name;
}

async function read(paths: string[]) {
  return tool.execute("call-1", { paths }, undefined, undefined, { cwd });
}

function textOf(result: Awaited<ReturnType<typeof read>>): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("registration", () => {
  it("is a tool in the agent loop, named for what it does", () => {
    expect(tool.name).toBe("batch_file_read");
  });

  it("tells the model when to prefer it over read", () => {
    expect(tool.description).toContain("one call");
    expect(tool.description).toContain("read");
  });
});

describe("reading several files", () => {
  it("returns every file, each under its own heading", async () => {
    fixture("a.ts", "contents of a\n");
    fixture("b.ts", "contents of b\n");
    const result = await read(["a.ts", "b.ts"]);

    const text = textOf(result);
    expect(result.isError).toBeFalsy();
    expect(text).toContain("===== a.ts =====");
    expect(text).toContain("contents of a");
    expect(text).toContain("===== b.ts =====");
    expect(text).toContain("contents of b");
  });

  it("keeps the order the model asked for", async () => {
    fixture("a.ts", "AAA\n");
    fixture("b.ts", "BBB\n");
    const text = textOf(await read(["b.ts", "a.ts"]));

    expect(text.indexOf("b.ts")).toBeLessThan(text.indexOf("a.ts"));
  });

  it("reports how many it actually read", async () => {
    fixture("a.ts", "x\n");
    fixture("b.ts", "y\n");
    const result = await read(["a.ts", "b.ts"]);

    expect(result.details).toMatchObject({
      filesRead: 2,
      filesRequested: 2,
      skipped: 0,
    });
  });

  it("reads the same file once, however many times it is named", async () => {
    fixture("a.ts", "only once\n");
    const result = await read(["a.ts", "a.ts", "./a.ts"]);

    expect(textOf(result).match(/===== /g)).toHaveLength(1);
    expect(result.details).toMatchObject({ filesRequested: 1 });
  });

  it("handles a single path, so the model is never wrong to use it", async () => {
    fixture("a.ts", "solo\n");

    expect(textOf(await read(["a.ts"]))).toContain("solo");
  });
});

describe("one bad path does not cost the others", () => {
  it("reports a missing file in place and still returns the rest", async () => {
    fixture("a.ts", "contents of a\n");
    const result = await read(["a.ts", "gone.ts"]);

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("contents of a");
    expect(textOf(result)).toContain("does not exist");
  });

  it("reports a directory rather than trying to read it", async () => {
    fs.mkdirSync(path.join(cwd, "sub"));
    fixture("a.ts", "contents of a\n");
    const result = await read(["sub", "a.ts"]);

    expect(textOf(result)).toContain("directory");
    expect(textOf(result)).toContain("contents of a");
  });

  it("reports a binary file rather than pasting bytes into the context", async () => {
    fs.writeFileSync(
      path.join(cwd, "blob.bin"),
      Buffer.from([0x41, 0x00, 0x42])
    );
    fixture("a.ts", "contents of a\n");
    const result = await read(["blob.bin", "a.ts"]);

    expect(textOf(result)).toContain("binary");
    expect(textOf(result)).toContain("contents of a");
  });

  it("says a file is empty rather than showing nothing at all", async () => {
    fixture("empty.ts", "");

    expect(textOf(await read(["empty.ts"]))).toContain("empty file");
  });

  // Skipped on Windows: chmod there cannot make a path unreadable.
  it.skipIf(process.platform === "win32")(
    "reports an unreadable file in place, still returning the rest",
    async () => {
      if (typeof process.getuid === "function" && process.getuid() === 0)
        return;
      const locked = fixture("locked.ts", "secret\n");
      fs.chmodSync(path.join(cwd, locked), 0o000);
      fixture("a.ts", "contents of a\n");

      const result = await read(["locked.ts", "a.ts"]);
      fs.chmodSync(path.join(cwd, locked), 0o644);

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain("not read");
      expect(textOf(result)).toContain("contents of a");
    }
  );

  it("points at read when one line alone will not fit the budget", async () => {
    // A minified bundle: one line, larger than the whole batch allowance.
    fixture("bundle.js", `${"x".repeat(80_000)}\n`);
    const result = await read(["bundle.js"]);

    expect(textOf(result)).toContain("Use read on this file by itself");
  });
});

describe("the shared budget", () => {
  it("caps a single huge file instead of returning all of it", async () => {
    fixture(
      "big.ts",
      Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join("\n")
    );
    const text = textOf(await read(["big.ts"]));

    expect(text).toContain("Use read with offset=");
    expect(text.split("\n").length).toBeLessThan(1_000);
  });

  it("spends the budget in the order asked, and names what did not fit", async () => {
    // Four files that together far exceed one read's budget, so the batch is
    // guaranteed to run out partway and has to say so.
    const bulk = Array.from(
      { length: 4_000 },
      (_, i) => `some reasonably long line of text ${i}`
    ).join("\n");
    for (const name of ["one.ts", "two.ts", "three.ts", "four.ts"])
      fixture(name, bulk);
    const result = await read(["one.ts", "two.ts", "three.ts", "four.ts"]);
    const text = textOf(result);

    // The files asked for first are the ones that get the budget.
    expect(text).toContain("===== one.ts =====");
    expect(result.details).toMatchObject({ filesRequested: 4 });
    expect((result.details as { skipped: number }).skipped).toBeGreaterThan(0);

    // Whatever could not be returned is named, never silently dropped.
    expect(text).toContain("===== not read =====");
    expect(text).toContain("four.ts");
  });

  it("does not let a batch return more than a single read would", async () => {
    const bulk = Array.from(
      { length: 4_000 },
      (_, i) => `some reasonably long line of text ${i}`
    ).join("\n");
    for (const name of ["a.ts", "b.ts", "c.ts", "d.ts"]) fixture(name, bulk);
    const text = textOf(await read(["a.ts", "b.ts", "c.ts", "d.ts"]));

    // 50KB is the ceiling one `read` gets; a batch must not exceed it, plus a
    // small allowance for the headings and continuation notices.
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(60 * 1024);
  });
});

describe("refusing calls it should not serve", () => {
  it("rejects an empty paths array", async () => {
    const result = await read([]);

    expect(result.isError).toBe(true);
  });

  it("refuses more files than it will return, instead of truncating the list", async () => {
    const paths = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
    const result = await read(paths);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("limit 20");
  });
});
