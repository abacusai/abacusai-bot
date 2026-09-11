/**
 * A page the agent wrote is only a deliverable once something serves it.
 *
 * These drive the real server over a real socket rather than stubbing `http`:
 * the failure this exists for was a server that reported itself ready and then
 * answered nothing, which a stub cannot reproduce.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  listServed,
  serveDirectory,
  stopAllServed,
  stopDirectory,
} from "./static-server";

const roots: string[] = [];

const workspace = async (files: Record<string, string>): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "serve-"));
  roots.push(root);

  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents, "utf8");
  }

  return root;
};

afterEach(async () => {
  stopAllServed();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});

describe("serving a directory", () => {
  it("answers on the URL it hands back", async () => {
    const root = await workspace({ "index.html": "<h1>Dating App</h1>" });
    const served = await serveDirectory(root);

    const response = await fetch(served.url);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Dating App");
  });

  it("serves index.html for the bare URL, so the link opens the app", async () => {
    const root = await workspace({
      "index.html": "<h1>Home</h1>",
      "style.css": "body{}",
    });
    const served = await serveDirectory(root);

    expect(await (await fetch(served.url)).text()).toContain("Home");
    expect(await (await fetch(`${served.url}/style.css`)).text()).toBe(
      "body{}"
    );
  });

  it("serves the only page when there is no index, so the folder URL is not a dead end", async () => {
    // A folder the agent wrote holds `love.html`, and the serve tool hands
    // back the folder URL. That used to answer "Not found".
    const root = await workspace({
      "love.html": "<h1>On Love</h1>",
      "love.pdf": "%PDF",
    });
    const served = await serveDirectory(root);

    expect(await (await fetch(served.url)).text()).toContain("On Love");
  });

  it("lists the pages when there are several and no index", async () => {
    const root = await workspace({
      "mid.html": "<h1>Mid</h1>",
      "opening.html": "<h1>Opening</h1>",
    });
    const served = await serveDirectory(root);

    const listing = await (await fetch(served.url)).text();
    expect(listing).toContain('href="/mid.html"');
    expect(listing).toContain('href="/opening.html"');
    expect(await (await fetch(`${served.url}/mid.html`)).text()).toContain(
      "Mid"
    );
  });

  it("labels content types, so css and js are not treated as bytes", async () => {
    const root = await workspace({
      "index.html": "x",
      "app.js": "const a = 1",
      "style.css": "body{}",
    });
    const served = await serveDirectory(root);

    expect(
      (await fetch(`${served.url}/app.js`)).headers.get("content-type")
    ).toContain("javascript");
    expect(
      (await fetch(`${served.url}/style.css`)).headers.get("content-type")
    ).toContain("css");
  });

  it("404s a file that is not there rather than hanging", async () => {
    const root = await workspace({ "index.html": "x" });
    const served = await serveDirectory(root);

    expect((await fetch(`${served.url}/missing.js`)).status).toBe(404);
  });

  it("refuses to climb out of the directory it was given", async () => {
    const root = await workspace({ "index.html": "x" });
    const served = await serveDirectory(root);

    // The served page is untrusted: it can ask this server for anything.
    const response = await fetch(`${served.url}/../../../etc/passwd`, {
      redirect: "manual",
    });

    expect([403, 404]).toContain(response.status);
  });

  it("returns the same URL when asked to serve the same directory twice", async () => {
    const root = await workspace({ "index.html": "x" });

    expect((await serveDirectory(root)).url).toBe(
      (await serveDirectory(root)).url
    );
    expect(listServed()).toHaveLength(1);
  });

  it("binds one server when the same directory is served concurrently", async () => {
    // Two starts racing used to both bind: the second overwrote the map entry
    // and the first server held its port with nothing able to stop it.
    const root = await workspace({ "index.html": "x" });
    const [first, second] = await Promise.all([
      serveDirectory(root),
      serveDirectory(root),
    ]);

    expect(second.port).toBe(first.port);
    expect(listServed()).toHaveLength(1);
  });

  it("refuses an empty directory, which would serve a 404 and look broken", async () => {
    const root = await workspace({});

    await expect(serveDirectory(root)).rejects.toThrow(/empty/i);
  });

  it("refuses a path that is not a directory", async () => {
    const root = await workspace({ "index.html": "x" });

    await expect(serveDirectory(path.join(root, "index.html"))).rejects.toThrow(
      /not a directory/i
    );
  });
});

describe("stopping", () => {
  it("stops answering, and says so when there was nothing to stop", async () => {
    const root = await workspace({ "index.html": "x" });
    const served = await serveDirectory(root);

    expect(stopDirectory(root)).toBe(true);
    expect(listServed()).toHaveLength(0);
    expect(stopDirectory(root)).toBe(false);

    await expect(
      fetch(served.url, { signal: AbortSignal.timeout(2000) })
    ).rejects.toThrow();
  });
});
