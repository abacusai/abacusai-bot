/**
 * `checkins`: turning check-ins off needs the user's clear word, every op
 * sends only its own field, and a server that does not know the action
 * changes nothing and says so.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildPhoneCheckinsTool,
  type CheckinsCall,
} from "./phone-checkins-tool.js";
import { phoneLanguage, phoneZone } from "./phone-nudges.js";

let dir: string;
let sent: Array<Record<string, unknown>>;
let answer: Record<string, unknown> | null;

const call: CheckinsCall = async (body) => {
  sent.push(body);
  return answer;
};

const run = (params: Record<string, unknown>) =>
  buildPhoneCheckinsTool(dir, call).execute("t1", params);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-checkins-"));
  sent = [];
  answer = { ok: true, enabled: true, quiet: "21:00-09:00", limit: 3 };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("checkins", () => {
  it("will not turn check-ins off without confirmed: true", async () => {
    const result = await run({ op: "off" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/ask them which they mean/);
    expect(sent).toEqual([]);
  });

  it("turns them off once confirmed, and reports the server's setting", async () => {
    answer = { ok: true, enabled: false };
    const result = await run({ op: "off", confirmed: true });
    expect(sent).toEqual([{ op: "off", enabled: false, confirmed: true }]);
    expect(result.content[0]!.text).toBe("Check-ins: off.");
  });

  it("sends each op's own field, checked first", async () => {
    await run({ op: "quiet", quiet: "22:00 - 08:00" });
    await run({ op: "limit", limit: 2 });
    await run({ op: "timezone", timezone: "Europe/Madrid" });
    await run({ op: "status" });
    expect(sent).toEqual([
      { op: "quiet", quiet: "22:00-08:00" },
      { op: "limit", limit: 2 },
      { op: "timezone", timezone: "Europe/Madrid" },
      { op: "status" },
    ]);
    expect(phoneZone(dir)).toBe("Europe/Madrid");
    for (const bad of [
      { op: "quiet", quiet: "late" },
      { op: "limit", limit: 50 },
      { op: "timezone", timezone: "Mars/Olympus" },
      { op: "language", language: "Spanish" },
      { op: "snooze" },
    ])
      expect((await run(bad)).isError).toBe(true);
    expect(sent).toHaveLength(4);
  });

  it("keeps the language for the agenda even when the server cannot take it", async () => {
    answer = null;
    const result = await run({ op: "language", language: "es" });
    expect(result.isError).toBeUndefined();
    expect(phoneLanguage(dir)).toBe("es");
  });

  it("says plainly that nothing changed when the server does not know check-ins", async () => {
    answer = null;
    const off = await run({ op: "off", confirmed: true });
    expect(off.isError).toBe(true);
    expect(off.content[0]!.text).toMatch(/nothing was changed/);
    const status = await run({ op: "status" });
    expect(status.isError).toBeUndefined();
  });
});
