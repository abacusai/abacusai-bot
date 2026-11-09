/**
 * A WhatsApp link that ended on an app from before `linkLost` saved only
 * `signedIn: false`. The one-time config upgrade marks it lost, so the lane
 * says so; nothing the user chose, and nothing never linked, is touched.
 *
 * Written against the real store: the upgrade is a file format change.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readPlatformLinkLost,
  readPlatformSignedIn,
  savePlatformSignedIn,
} from "./messaging-config-service";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

const storePath = (): string => path.join(home, "messaging.json");

const writeStore = (config: unknown): void => {
  fs.writeFileSync(storePath(), JSON.stringify(config), "utf8");
};

const readStore = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(storePath(), "utf8")) as Record<string, unknown>;

/** What a link that died on an older app left behind. */
const signedOutStill = { enabled: true, signedIn: false };
const linkedOnce = { autoReplyBootstrappedFor: ["whatsapp"] };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-upgrade-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("the lost-link upgrade", () => {
  it.each([
    ["its self chat was found", linkedOnce],
    [
      "someone wrote in on it",
      {
        pairing: [
          {
            platform: "whatsapp",
            userId: "u1",
            chatId: "c1",
            status: "approved",
          },
        ],
      },
    ],
  ])("marks a lane still on but signed out as lost when %s", (_, evidence) => {
    writeStore({ ...evidence, platforms: { whatsapp: signedOutStill } });

    expect(readPlatformLinkLost("whatsapp")).toBe(true);
    expect(readStore()).toMatchObject({
      configVersion: 1,
      platforms: { whatsapp: { ...signedOutStill, linkLost: true } },
    });
  });

  it.each([
    [
      "the user unlinked it",
      { enabled: false, signedIn: false, linkLost: false },
    ],
    [
      "an older app's Unlink switched it off",
      { enabled: false, signedIn: false },
    ],
    ["it is signed in", { enabled: true, signedIn: true }],
    ["it was never recorded", { enabled: true }],
    ["a newer app already decided", { ...signedOutStill, linkLost: false }],
  ])("leaves the lane alone when %s", (_, whatsapp) => {
    writeStore({ ...linkedOnce, platforms: { whatsapp } });

    expect(readPlatformLinkLost("whatsapp")).toBe(false);
    expect(readStore()).toEqual({
      ...linkedOnce,
      platforms: { whatsapp },
      configVersion: 1,
    });
  });

  it("leaves a lane that showed a QR but was never linked alone", () => {
    writeStore({ platforms: { whatsapp: signedOutStill } });

    expect(readPlatformLinkLost("whatsapp")).toBe(false);
    expect(readPlatformSignedIn("whatsapp")).toBe(false);
  });

  it("leaves other chat apps alone: the flag is WhatsApp's", () => {
    writeStore({
      autoReplyBootstrappedFor: ["whatsapp", "abacus_discord"],
      platforms: { discord: signedOutStill, telegram: signedOutStill },
    });

    expect(readPlatformLinkLost("discord")).toBe(false);
    expect(readPlatformLinkLost("telegram")).toBe(false);
  });

  it("writes nothing for a new install, and its first save is current", () => {
    expect(readPlatformLinkLost("whatsapp")).toBe(false);
    expect(fs.existsSync(storePath())).toBe(false);

    savePlatformSignedIn("whatsapp", false);

    expect(readStore()).toEqual({
      configVersion: 1,
      platforms: { whatsapp: { signedIn: false } },
    });
  });

  it("runs once: a config already upgraded is read as it stands", () => {
    writeStore({
      ...linkedOnce,
      platforms: { whatsapp: signedOutStill },
      configVersion: 1,
    });
    const before = fs.readFileSync(storePath(), "utf8");

    expect(readPlatformLinkLost("whatsapp")).toBe(false);
    expect(fs.readFileSync(storePath(), "utf8")).toBe(before);
  });

  it("runs once: a relink after the upgrade stays cleared", () => {
    writeStore({ ...linkedOnce, platforms: { whatsapp: signedOutStill } });
    expect(readPlatformLinkLost("whatsapp")).toBe(true);

    savePlatformSignedIn("whatsapp", true);
    savePlatformSignedIn("whatsapp", false);

    expect(readPlatformLinkLost("whatsapp")).toBe(false);
  });
});
