/**
 * Auto-replies live beside the schedules now, with the same verbs: a pause
 * keeps the grant but stops the answers, resume restores them, delete
 * removes the sender. Pinned at the store level: approvedUserIds is what
 * inbound routing consults, so "paused senders are not answered" is exactly
 * "paused rows are not in that set".
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  approvePairing,
  approvedUserIds,
  listPairing,
  pausePairing,
  recordPairingRequest,
} from "./messaging-config-service";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-auto-reply-pause-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("pausing an auto-reply", () => {
  it("takes the sender out of the answered set, and resume puts them back", () => {
    recordPairingRequest({
      platform: "whatsapp",
      userId: "girlies",
      userName: "Girlies Together",
      chatId: "girlies",
      firstMessage: "hello",
    });
    approvePairing("whatsapp", "girlies", { managedBy: "bot" });
    expect(approvedUserIds("whatsapp").has("girlies")).toBe(true);

    pausePairing("whatsapp", "girlies");
    expect(approvedUserIds("whatsapp").has("girlies")).toBe(false);
    // The grant survives; paused, not forgotten.
    expect(listPairing()[0]?.status).toBe("paused");
    expect(listPairing()[0]?.managedBy).toBe("bot");

    approvePairing("whatsapp", "girlies");
    expect(approvedUserIds("whatsapp").has("girlies")).toBe(true);
    expect(listPairing()[0]?.managedBy).toBe("bot");
  });
});
