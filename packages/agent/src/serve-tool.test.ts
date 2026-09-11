/**
 * Serving a directory, and not serving anything else.
 *
 * The traversal guard is the assertion that earns its keep: the server is bound
 * to loopback, but a page in it can still ask for any path it likes, and
 * "anything" has to stop at the directory the agent named.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildServeTool } from "./serve-tool.js";
import { listServed, serveDirectory, stopAllServed } from "./static-server.js";

let workspace: string;

const tool = () => buildServeTool(() => workspace);
const run = async (params: Record<string, unknown>) =>
  await tool().execute("call-1", params);
const textOf = async (params: Record<string, unknown>) =>
  (await run(params)).content[0]!.text;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-serve-"));
  fs.mkdirSync(path.join(workspace, "site"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "site", "index.html"),
    "<h1>hello</h1>",
    "utf8"
  );
  fs.writeFileSync(
    path.join(workspace, "secret.txt"),
    "do not serve me",
    "utf8"
  );
});

afterEach(() => {
  stopAllServed();
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("serving a directory", () => {
  it("returns a loopback URL for a relative path resolved against the workspace", async () => {
    const text = await textOf({ action: "start", directory: "site" });

    expect(text).toContain("http://127.0.0.1:");
    expect(text).toContain("Hand it over: present_deliverable");
  });

  it("binds one server when the same directory is served concurrently", async () => {
    // Two starts racing used to both bind: the second overwrote the map entry
    // and the first server held its port with nothing able to stop it.
    const dir = path.join(workspace, "site");
    const [first, second] = await Promise.all([
      serveDirectory(dir),
      serveDirectory(dir),
    ]);

    expect(second.port).toBe(first.port);
    expect(listServed()).toHaveLength(1);
  });

  it("returns the same URL when asked to serve the same directory again", async () => {
    const first = await textOf({ action: "start", directory: "site" });
    const second = await textOf({ action: "start", directory: "site" });
    const url = (body: string) => body.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];

    expect(url(second)).toBe(url(first));
  });

  it("actually serves the index", async () => {
    const started = await textOf({ action: "start", directory: "site" });
    const url = started.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("hello");
  });

  /** The whole threat model: a request must not climb out of the served root. */
  it("refuses a path that climbs out of the served directory", async () => {
    const started = await textOf({ action: "start", directory: "site" });
    const url = started.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
    const response = await fetch(`${url}/../secret.txt`, {
      redirect: "manual",
    });

    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain("do not serve me");
  });

  it("lists what is running, and says so when nothing is", async () => {
    expect(await textOf({ action: "list" })).toBe("Nothing is being served.");

    await run({ action: "start", directory: "site" });

    expect(await textOf({ action: "list" })).toContain("127.0.0.1");
  });

  it("stops a directory, and says so when it was not being served", async () => {
    await run({ action: "start", directory: "site" });

    expect(await textOf({ action: "stop", directory: "site" })).toBe(
      "Stopped."
    );
    expect(await textOf({ action: "stop", directory: "site" })).toBe(
      "That directory was not being served."
    );
  });

  it("refuses an empty directory, since there would be nothing to open", async () => {
    fs.mkdirSync(path.join(workspace, "blank"));

    const result = await run({ action: "start", directory: "blank" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("empty");
  });

  it("requires a directory for start and stop", async () => {
    expect((await run({ action: "start" })).isError).toBe(true);
  });

  it("reports an unknown action", async () => {
    expect((await run({ action: "sing" })).isError).toBe(true);
  });
});
