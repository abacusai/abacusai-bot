import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { SITE_ZIP_CONVERSATION } from "@abacus-ai/contract/site-deploy";
import { afterEach, describe, expect, it } from "vitest";

import {
  isSiteExport,
  packSite,
  siteDirTooBroad,
  siteExportDir,
  siteExportsDir,
} from "./site-pack";

const roots: string[] = [];
const tree = (files: Record<string, string>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "site-pack-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, "bakery", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

const pack = (
  root: string,
  signal = new AbortController().signal,
  asked = "Build my bakery site"
) =>
  packSite({
    siteDir: path.join(root, "bakery"),
    messages: [
      {
        id: "1",
        role: "user",
        parts: [{ type: "text", content: asked }],
      },
      {
        id: "2",
        role: "assistant",
        parts: [{ type: "text", content: "Done." }],
      },
    ] as never,
    outDir: path.join(root, "out"),
    signal,
    onProgress: () => undefined,
  });

/** The archive's entry names, read off its central directory. */
const entries = (zip: Buffer): string[] => {
  const names: string[] = [];
  for (
    let at = zip.indexOf("PK\x01\x02");
    at >= 0;
    at = zip.indexOf("PK\x01\x02", at + 4)
  ) {
    const length = zip.readUInt16LE(at + 28);
    names.push(zip.subarray(at + 46, at + 46 + length).toString("utf8"));
  }
  return names;
};

/** One entry's text, inflated off its local header. */
const entry = (zip: Buffer, name: string): string => {
  const at = zip.indexOf(name);
  const size = zip.readUInt32LE(at - 30 + 18);
  const start = at + name.length;
  return zlib.inflateRawSync(zip.subarray(start, start + size)).toString();
};

describe("siteExportDir", () => {
  it("gives each chat its own folder, inside the exports", () => {
    expect(siteExportDir("chat-1")).not.toBe(siteExportDir("chat-2"));
    for (const id of ["chat-1", "../../outside", "a/b:c"]) {
      expect(path.dirname(siteExportDir(id))).toBe(siteExportsDir());
      expect(isSiteExport(path.join(siteExportDir(id), "site.zip"))).toBe(true);
    }
  });
});

describe("packSite", () => {
  it("sends the project and the conversation, never dependencies, history or keys", async () => {
    const root = tree({
      "index.html": "<h1>Bakery</h1>",
      "css/site.css": "h1{}",
      ".env": "API_KEY=abc",
      ".env.example": "API_KEY=",
      // A key's shape, built here so no scanner reads it as a real one.
      "config.js": `const key = '${["sk", "a1".repeat(12)].join("-")}';`,
      "login.ts": 'const password = form.get("password");',
      "node_modules/x/index.js": "x",
      ".git/HEAD": "ref",
    });
    const result = await pack(root);
    expect(result).toMatchObject({
      state: "ready",
      name: "bakery",
      files: 4,
      leftOut: [".git", "node_modules"],
      heldBack: [".env", "config.js"],
    });
    if (result.state !== "ready") return;
    const zip = fs.readFileSync(result.path);
    expect(entries(zip).sort()).toEqual(
      [
        "bakery/.env.example",
        "bakery/css/site.css",
        "bakery/index.html",
        "bakery/login.ts",
        SITE_ZIP_CONVERSATION,
      ].sort()
    );
  });

  it("takes keys out of the conversation it writes in", async () => {
    const key = ["sk", "a1".repeat(12)].join("-");
    const root = tree({ "index.html": "<h1>Bakery</h1>" });
    const result = await pack(root, undefined, `Use this key: ${key}`);
    if (result.state !== "ready") throw new Error(result.state);
    const written = entry(fs.readFileSync(result.path), SITE_ZIP_CONVERSATION);
    expect(written).toContain("Use this key");
    expect(written).not.toContain(key);
  });

  it("says a project over the limits is too big, and a cancel is a cancel", async () => {
    const big = tree({ "video.bin": "" });
    fs.writeFileSync(
      path.join(big, "bakery", "video.bin"),
      Buffer.alloc(26 * 1024 * 1024)
    );
    expect(await pack(big)).toEqual({ state: "too-big", name: "bakery" });

    const stopped = new AbortController();
    stopped.abort();
    expect(await pack(tree({ "index.html": "x" }), stopped.signal)).toEqual({
      state: "cancelled",
    });
  });

  it("refuses a folder that is not the site's own", () => {
    const home = "/home/me";
    const bot = "/home/me/.abacusai-bot";
    expect(siteDirTooBroad("/", null, home, bot)).toBe(true);
    expect(siteDirTooBroad(home, null, home, bot)).toBe(true);
    expect(siteDirTooBroad(bot, null, home, bot)).toBe(true);
    expect(siteDirTooBroad(`${bot}/bots/b1`, `${bot}/bots/b1`, home, bot)).toBe(
      true
    );
    expect(
      siteDirTooBroad(`${bot}/bots/b1/site`, `${bot}/bots/b1`, home, bot)
    ).toBe(false);
    expect(
      siteDirTooBroad(
        "/home/me/Sites/bakery",
        "/home/me/Sites/bakery",
        home,
        bot
      )
    ).toBe(false);
  });

  it.each([
    ["the desktop", "/home/me/Desktop"],
    ["documents", "/home/me/Documents"],
    ["downloads", "/home/me/Downloads"],
    ["a lower-case name", "/home/me/downloads"],
    ["pictures", "/home/me/Pictures"],
    ["a synced desktop", "/home/me/OneDrive/Desktop"],
    ["app data", "/home/me/Library/Caches"],
    ["the temp folder", os.tmpdir()],
    ["shared temp", "/tmp"],
    ["a folder in temp", "/tmp/report"],
  ])("refuses %s", (_name, dir) => {
    expect(siteDirTooBroad(dir, null, "/home/me", "/home/me/.bot")).toBe(true);
  });

  it("takes a project folder inside a standard one", () => {
    expect(
      siteDirTooBroad(
        "/home/me/Desktop/bakery",
        null,
        "/home/me",
        "/home/me/.bot"
      )
    ).toBe(false);
  });

  it("follows a link to the folder it names", () => {
    const root = tree({ "home/Desktop/report.html": "x" });
    const home = path.join(root, "bakery", "home");
    const link = path.join(home, "work");
    fs.symlinkSync(path.join(home, "Desktop"), link, "junction");
    expect(siteDirTooBroad(link, null, home, path.join(home, ".bot"))).toBe(
      true
    );
  });
});
