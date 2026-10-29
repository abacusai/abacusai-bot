/**
 * A served page's URL outlives the process serving it: the files card, the
 * pane's tab and the agent's next turn all still hold it after the app
 * restarts. These drive real servers over real sockets, with `stopAllServed`
 * standing in for the restart (the quit path calls it; the remembered ports
 * on disk are what survive).
 */
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { revivePreview, servePreview, stopPreview } from "./served-previews";
import { listServed, stopAllServed } from "./static-server";

let home: string;
const savedHome = process.env.ABACUSAI_BOT_HOME;
const strangers: http.Server[] = [];

const site = (name: string, page = "<h1>App</h1>"): string => {
  const directory = path.join(home, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "index.html"), page);
  return directory;
};

/** Something else taking `port`, as another program might while the app was closed. */
const occupy = async (port: number): Promise<void> => {
  const stranger = http.createServer((_request, response) =>
    response.end("someone else")
  );
  strangers.push(stranger);
  await new Promise<void>((resolve) =>
    stranger.listen(port, "127.0.0.1", resolve)
  );
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "served-previews-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(async () => {
  stopAllServed();
  for (const stranger of strangers.splice(0))
    await new Promise((resolve) => stranger.close(resolve));
  if (savedHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("a served page after a restart", () => {
  it("is served again on its own URL when that URL is opened", async () => {
    const before = await servePreview(site("game", "<h1>Game</h1>"));
    stopAllServed();
    await expect(fetch(before.url)).rejects.toThrow();

    const url = await revivePreview(`${before.url}/index.html`);

    expect(url).toBe(`${before.url}/index.html`);
    expect(await (await fetch(url)).text()).toContain("Game");
  });

  it("gets its old port back when the agent serves the folder again", async () => {
    const directory = site("game");
    const before = await servePreview(directory);
    stopAllServed();

    expect((await servePreview(directory)).url).toBe(before.url);
  });

  it("moves to a free port when another program took its own, and the URL says so", async () => {
    const before = await servePreview(site("game", "<h1>Game</h1>"));
    stopAllServed();
    await occupy(before.port);

    const url = await revivePreview(`${before.url}/`);

    expect(new URL(url).port).not.toBe(String(before.port));
    expect(await (await fetch(url)).text()).toContain("Game");
    // Remembered there now, so the next open lands on the same place.
    stopAllServed();
    expect(await revivePreview(url)).toBe(url);
  });

  it("is left alone while it is still being served", async () => {
    const served = await servePreview(site("game"));

    expect(await revivePreview(served.url)).toBe(served.url);
    expect(listServed()).toHaveLength(1);
  });
});

describe("what is never brought back", () => {
  it("a folder serve stopped on purpose", async () => {
    const directory = site("game");
    const before = await servePreview(directory);
    stopPreview(directory);

    expect(await revivePreview(before.url)).toBe(before.url);
    expect(listServed()).toEqual([]);
  });

  it("a folder that is gone, which is then forgotten", async () => {
    const directory = site("game");
    const before = await servePreview(directory);
    stopAllServed();
    fs.rmSync(directory, { recursive: true, force: true });

    expect(await revivePreview(before.url)).toBe(before.url);
    expect(listServed()).toEqual([]);
    site("game");
    expect(await revivePreview(before.url)).toBe(before.url);
    expect(listServed()).toEqual([]);
  });

  it("a port nothing was served on, and any URL not on this computer", async () => {
    const stranger = http.createServer();
    await new Promise<void>((resolve) =>
      stranger.listen(0, "127.0.0.1", resolve)
    );
    const port = (stranger.address() as AddressInfo).port;
    await new Promise((resolve) => stranger.close(resolve));

    for (const url of [
      `http://127.0.0.1:${port}/`,
      "https://example.com/",
      "http://192.168.1.10:8080/",
    ])
      expect(await revivePreview(url)).toBe(url);
    expect(listServed()).toEqual([]);
  });
});
