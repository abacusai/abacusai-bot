import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { connectInProcess, fakeDeps } from "../../rpc/testing";
import { acknowledgeLegacyDrafts, pendingLegacyDrafts } from "./legacy-drafts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    fs.rmSync(home, { recursive: true, force: true });
});
const botHome = (files: Record<string, string | null>) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-drafts-"));
  homes.push(home);
  fs.mkdirSync(path.join(home, "electron"));
  for (const [name, text] of Object.entries(files))
    if (text == null) fs.mkdirSync(path.join(home, "electron", name));
    else fs.writeFileSync(path.join(home, "electron", name), text);
  return home;
};
const SESSION = "3f2b6c1e-8a4d-4f7e-9c21-5d0e7b9a1c42";
// What v1.0.85 wrote: `composer.draft:` + the composer key.
const V1_0_85 = JSON.stringify({
  [`composer.draft:session:${SESSION}`]: "unsent words",
  "composer.draft:workspace:ws-1": "new-session words",
  "composer.draft:session:empty": "",
  unrelated: "retained",
});

it("reads v1.0.85 drafts under the keys the composers use and remembers acknowledged ones", () => {
  const home = botHome({ "renderer-state.json": V1_0_85 });
  expect(pendingLegacyDrafts(home)).toEqual({
    [SESSION]: "unsent words",
    "workspace:ws-1": "new-session words",
  });
  acknowledgeLegacyDrafts(home, [SESSION]);
  expect(pendingLegacyDrafts(home)).toEqual({
    "workspace:ws-1": "new-session words",
  });
  expect(
    fs.readFileSync(path.join(home, "electron", "renderer-state.json"), "utf8")
  ).toBe(V1_0_85);
});

it("reads a malformed receipts file as nothing acknowledged", () => {
  const home = botHome({
    "renderer-state.json": V1_0_85,
    "composer-drafts.imported.json": "{not json",
  });
  expect(Object.keys(pendingLegacyDrafts(home))).toHaveLength(2);
  acknowledgeLegacyDrafts(home, [SESSION]);
  expect(Object.keys(pendingLegacyDrafts(home))).toEqual(["workspace:ws-1"]);
});

it("answers system.info when the v1.0.85 state cannot be read", async () => {
  const home = botHome({ "renderer-state.json": null });
  expect(() => pendingLegacyDrafts(home)).toThrow();
  const connection = connectInProcess(
    fakeDeps({
      app: {
        homeDir: () => home,
        appVersion: () => "1.1.0",
        botHome: () => home,
        legacyInstall: () => true,
        systemLanguages: () => [],
        trayAvailable: () => null,
      },
      host: { sessionHomePath: () => home },
      serviceHost: { getMetadata: () => ({ materialIconsBasePath: "" }) },
    })
  );
  try {
    await expect(connection.client.system.info()).resolves.toMatchObject({
      legacyComposerDrafts: {},
    });
  } finally {
    connection.closeClient();
    connection.closeServer();
  }
});
