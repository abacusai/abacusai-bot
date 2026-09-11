/**
 * Who is allowed to drive the agent from a chat app.
 *
 * This is the security boundary the messaging gateway describes as such: an
 * approved sender can run an agent on the user's machine, and there is no open
 * mode. Every inbound message is checked against `approvedUserIds`, so the ways
 * that set could be wrong are the ways a stranger gets a shell.
 *
 * Written against the real store rather than a mock — the file format is half
 * the contract, and a test that stubs it cannot catch a row being read back
 * differently from how it was written.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  approvedUserIds,
  findPairing,
  listPairing,
} from "./messaging-config-service";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

const writeStore = (pairing: unknown): void => {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "messaging.json"),
    JSON.stringify({ pairing }),
    "utf8"
  );
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-messaging-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;

  fs.rmSync(home, { recursive: true, force: true });
});

describe("the approved set", () => {
  it("is empty when nothing has been paired", () => {
    expect(approvedUserIds("telegram").size).toBe(0);
  });

  it("is empty when the store does not exist at all", () => {
    fs.rmSync(path.join(home, "messaging.json"), { force: true });

    expect(approvedUserIds("telegram").size).toBe(0);
  });

  it("contains only senders whose status is approved", () => {
    // A pending request is a stranger who messaged once. Admitting them would
    // defeat the entire pairing flow.
    writeStore([
      { platform: "telegram", userId: "yes", status: "approved", chatId: "1" },
      {
        platform: "telegram",
        userId: "waiting",
        status: "pending",
        chatId: "2",
      },
      { platform: "telegram", userId: "nope", status: "denied", chatId: "3" },
    ]);

    expect([...approvedUserIds("telegram")]).toEqual(["yes"]);
  });

  it("does not leak an approval across platforms", () => {
    // Ids are only unique within a platform, so approving 12345 on Telegram
    // must not approve whoever 12345 is on Discord.
    writeStore([
      {
        platform: "telegram",
        userId: "12345",
        status: "approved",
        chatId: "1",
      },
    ]);

    expect(approvedUserIds("telegram").has("12345")).toBe(true);
    expect(approvedUserIds("discord").has("12345")).toBe(false);
  });

  it("matches ids exactly, with no trimming or case folding", () => {
    writeStore([
      {
        platform: "telegram",
        userId: "AbC123",
        status: "approved",
        chatId: "1",
      },
    ]);

    const approved = approvedUserIds("telegram");

    expect(approved.has("AbC123")).toBe(true);
    expect(approved.has("abc123")).toBe(false);
    expect(approved.has(" AbC123 ")).toBe(false);
    expect(approved.has("AbC1234")).toBe(false);
  });
});

describe("a store that is not what we expect", () => {
  it("ignores rows whose id is not a string", () => {
    // Telegram ids are numbers on the wire. A row written as a number would
    // never match the string the connector checks with, so it is dropped rather
    // than compared loosely — a `==` here would be an authorisation bug.
    writeStore([
      { platform: "telegram", userId: 12345, status: "approved", chatId: "1" },
      { platform: "telegram", userId: "ok", status: "approved", chatId: "2" },
    ]);

    expect([...approvedUserIds("telegram")]).toEqual(["ok"]);
  });

  it("ignores rows for a platform that is not in the catalog", () => {
    writeStore([
      { platform: "irc", userId: "someone", status: "approved", chatId: "1" },
    ]);

    expect(listPairing()).toHaveLength(0);
  });

  it("survives a corrupt store instead of throwing", () => {
    // A half-written file must fail closed, not crash the gateway.
    fs.writeFileSync(
      path.join(home, "messaging.json"),
      '{"pairing": [',
      "utf8"
    );

    expect(() => approvedUserIds("telegram")).not.toThrow();
    expect(approvedUserIds("telegram").size).toBe(0);
  });

  it("survives pairing being the wrong type", () => {
    writeStore("not-an-array");

    expect(approvedUserIds("telegram").size).toBe(0);
  });
});

describe("looking a sender up", () => {
  it("finds a row by platform and id together", () => {
    writeStore([
      { platform: "telegram", userId: "a", status: "approved", chatId: "1" },
      { platform: "discord", userId: "a", status: "pending", chatId: "2" },
    ]);

    expect(findPairing("telegram", "a")?.status).toBe("approved");
    expect(findPairing("discord", "a")?.status).toBe("pending");
  });

  it("returns null for a sender it has never seen", () => {
    expect(findPairing("telegram", "stranger")).toBeNull();
  });
});
