/**
 * The handover tool, as the agent registers it.
 *
 * What matters here is that a deliverable never reports as shown when it is
 * not: the desktop's version exists partly because a path named in prose is
 * neither linked nor recorded, and a version that cheerfully listed files that
 * are not there would be worse than none — the model would tell the user the
 * work was delivered and the user would find nothing.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPresentDeliverableTool } from "./present-deliverable-tool.js";

let workspace: string;

const run = async (params: Record<string, unknown>) =>
  await buildPresentDeliverableTool(() => workspace).execute("call-1", params);

const write = (relative: string): string => {
  const target = path.join(workspace, relative);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "x", "utf8");

  return target;
};

beforeEach(() => {
  workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), "abacusai-bot-deliverable-")
  );
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("handing the work over", () => {
  it("links a file that exists, resolved against the workspace", async () => {
    write("out/report.pdf");

    const result = await run({
      items: [{ path: "out/report.pdf", label: "The report" }],
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain("[The report](file://");
    expect(result.content[0]!.text).toContain("report.pdf");
  });

  it("falls back to the file name when no label is given", async () => {
    write("out/report.pdf");

    expect(
      (await run({ items: [{ path: "out/report.pdf" }] })).content[0]!.text
    ).toContain("[report.pdf]");
  });

  it("leads with the summary when there is one", async () => {
    write("a.txt");

    const text = (
      await run({ items: [{ path: "a.txt" }], summary: "One file." })
    ).content[0]!.text;

    expect(text.startsWith("One file.\n")).toBe(true);
  });

  it("names the first item as the primary deliverable", async () => {
    write("a.txt");
    write("b.txt");

    const text = (await run({ items: [{ path: "a.txt" }, { path: "b.txt" }] }))
      .content[0]!.text;

    expect(text).toContain("a.txt is the primary deliverable.");
  });

  /** A URL is served by something else and cannot be stat'ed, so it is taken as given. */
  it("accepts an http URL without touching the filesystem", async () => {
    const text = (
      await run({
        items: [{ path: "http://127.0.0.1:5173", label: "The app" }],
      })
    ).content[0]!.text;

    expect(text).toContain("[The app](http://127.0.0.1:5173)");
  });

  it("names a missing file rather than dropping it", async () => {
    write("real.txt");

    const text = (
      await run({ items: [{ path: "real.txt" }, { path: "ghost.txt" }] })
    ).content[0]!.text;

    expect(text).toContain("real.txt");
    expect(text).toContain(
      "Not presented, because there is no file at these paths"
    );
    expect(text).toContain("ghost.txt");
  });

  it("declares exactly the items that exist, for the files card to read", async () => {
    const real = write("real.txt");

    const text = (
      await run({
        items: [
          { path: "real.txt" },
          { path: "ghost.txt" },
          { path: "http://localhost:5173" },
        ],
      })
    ).content[0]!.text;

    const declared = text
      .split("\n")
      .filter((line) => line.startsWith("[artifact] "))
      .map((line) => line.slice("[artifact] ".length));
    expect(declared).toEqual([real, "http://localhost:5173"]);
  });

  it("fails when nothing named exists, rather than reporting a successful handover", async () => {
    const result = await run({ items: [{ path: "ghost.txt" }] });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Nothing could be presented");
  });

  it("fails on an empty list", async () => {
    expect((await run({ items: [] })).isError).toBe(true);
  });

  /** The desktop escapes these the same way, and decodes before opening. */
  it("escapes a space and a hash in the path", async () => {
    write("my report #2.pdf");

    const text = (await run({ items: [{ path: "my report #2.pdf" }] }))
      .content[0]!.text;

    expect(text).toContain("%20");
    expect(text).toContain("%23");
  });
});
