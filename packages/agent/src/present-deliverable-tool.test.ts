/**
 * The handover tool, as the agent registers it.
 *
 * What matters here is that a deliverable never reports as shown when it is
 * not: the desktop's version exists partly because a path named in prose is
 * neither linked nor recorded, and a version that cheerfully listed files that
 * are not there would be worse than none: the model would tell the user the
 * work was delivered and the user would find nothing.
 */
import fs from "fs";
import http from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPresentDeliverableTool } from "./present-deliverable-tool.js";

let workspace: string;
const servers: http.Server[] = [];

/** A real server on a free loopback port, answering every request with `status`. */
const listening = async (status = 200): Promise<string> => {
  const server = http.createServer((_request, response) => {
    response.writeHead(status).end("ok");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

/** A loopback URL nothing listens on: a server that was stopped. */
const stopped = async (): Promise<string> => {
  const url = await listening();
  await new Promise((resolve) => servers.pop()!.close(resolve));
  return url;
};

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

afterEach(async () => {
  fs.rmSync(workspace, { recursive: true, force: true });
  for (const server of servers.splice(0))
    await new Promise((resolve) => server.close(resolve));
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

  it("presents a URL that answers, and says it was checked", async () => {
    const url = await listening();
    const text = (await run({ items: [{ path: url, label: "The app" }] }))
      .content[0]!.text;

    expect(text).toContain(`[The app](${url})`);
    expect(text).toContain(`${url} answered (HTTP 200).`);
  });

  /** An app reported done whose server is not running is the failure this guards. */
  it("refuses a URL nothing answers, and a local one that answers an error", async () => {
    for (const url of [await stopped(), await listening(404)]) {
      const result = await run({ items: [{ path: url }] });

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("Nothing could be presented");
      expect(result.content[0]!.text).toContain(url);
    }
  });

  it("presents the files beside a dead URL and names the URL as not presented", async () => {
    const real = write("index.html");
    const dead = await stopped();
    const text = (
      await run({ items: [{ path: dead }, { path: "index.html" }] })
    ).content[0]!.text;

    expect(text).toContain(`[artifact] ${real}`);
    expect(text).not.toContain(`[artifact] ${dead}`);
    expect(text).toContain("Not presented, because nothing answered there:");
    expect(text).toContain("connection refused");
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

  it("finds a file whose name the model wrote with a plain space where the disk has a narrow one", async () => {
    // macOS screenshots carry U+202F before "AM"; the model never does.
    const real = write("Screenshot 2026-09-14 at 12.55.59\u202fAM.png");

    const text = (
      await run({
        items: [{ path: "Screenshot 2026-09-14 at 12.55.59 AM.png" }],
      })
    ).content[0]!.text;

    expect(text).toContain(`[artifact] ${real}`);
    expect(text).not.toContain("Not presented");
  });

  it("declares exactly the items that exist, for the files card to read", async () => {
    const real = write("real.txt");
    const url = await listening();

    const text = (
      await run({
        items: [{ path: "real.txt" }, { path: "ghost.txt" }, { path: url }],
      })
    ).content[0]!.text;

    const declared = text
      .split("\n")
      .filter((line) => line.startsWith("[artifact] "))
      .map((line) => line.slice("[artifact] ".length));
    expect(declared).toEqual([real, url]);
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
