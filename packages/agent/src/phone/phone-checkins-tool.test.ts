/**
 * `checkins`: turning check-ins off needs the user's clear word, every op
 * sends only its own field, what is kept locally is only what the server
 * took, and a server that does not know the action changes nothing and
 * says so.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildPhoneCheckinsTool,
  type CheckinsAnswer,
  type CheckinsCall,
} from "./phone-checkins-tool.js";
import {
  phoneLanguage,
  phoneZone,
  writePhoneLanguage,
} from "./phone-nudges.js";

let dir: string;
let sent: Array<Record<string, unknown>>;
let answer: (body: Record<string, unknown>) => CheckinsAnswer;

const settings = (over: Record<string, unknown> = {}): CheckinsAnswer => ({
  kind: "settings",
  settings: {
    ok: true,
    enabled: true,
    quiet: "21:00-09:00",
    limit: null,
    timezone: null,
    language: null,
    ...over,
  },
});

const call: CheckinsCall = async (body) => {
  sent.push(body);
  return answer(body);
};

const run = (params: Record<string, unknown>) =>
  buildPhoneCheckinsTool(dir, call).execute("t1", params);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-checkins-"));
  sent = [];
  answer = () => settings();
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
    answer = () => settings({ enabled: false });
    const result = await run({ op: "off", confirmed: true });
    expect(sent).toEqual([{ op: "off", enabled: false, confirmed: true }]);
    expect(result.content[0]!.text).toMatch(/^Check-ins: off\./);
  });

  it("sends each op's own field, checked first, and null resets", async () => {
    await run({ op: "quiet", quiet: "22:00 - 08:00" });
    await run({ op: "limit", limit: 2 });
    await run({ op: "limit", limit: null });
    await run({ op: "timezone", timezone: null });
    await run({ op: "language", language: null });
    await run({ op: "status" });
    expect(sent).toEqual([
      { op: "quiet", quiet: "22:00-08:00" },
      { op: "limit", limit: 2 },
      { op: "limit", limit: null },
      { op: "timezone", timezone: null },
      { op: "language", language: null },
      { op: "status" },
    ]);
    for (const bad of [
      { op: "quiet", quiet: "late" },
      { op: "limit", limit: 50 },
      { op: "timezone", timezone: "Mars/Olympus" },
      { op: "language", language: "Spanish" },
      { op: "snooze" },
    ])
      expect((await run(bad)).isError).toBe(true);
    expect(sent).toHaveLength(6);
  });

  it("keeps the language and zone only as the server took them", async () => {
    answer = (body) =>
      settings({ language: body.language, timezone: body.timezone ?? null });
    await run({ op: "language", language: "PT_br" });
    expect(sent.at(-1)).toEqual({ op: "language", language: "pt-BR" });
    expect(phoneLanguage(dir)).toBe("pt-BR");
    await run({ op: "timezone", timezone: "Europe/Madrid" });
    expect(phoneZone(dir)).toBe("Europe/Madrid");
    await run({ op: "timezone", timezone: null });
    expect(phoneZone(dir)).toBeNull();
  });

  it("keeps nothing and says why when the server refuses", async () => {
    answer = () => ({ kind: "refused", reason: "language must be a code" });
    const result = await run({ op: "language", language: "es" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(
      /Not changed: language must be a code/
    );
    expect(phoneLanguage(dir)).toBeNull();
  });

  it("says plainly that nothing changed when the server does not know check-ins, and keeps nothing", async () => {
    writePhoneLanguage(dir, "es");
    answer = () => ({ kind: "unavailable" });
    const off = await run({ op: "off", confirmed: true });
    expect(off.isError).toBe(true);
    expect(off.content[0]!.text).toMatch(/nothing was changed/);
    const language = await run({ op: "language", language: "fr" });
    expect(language.isError).toBe(true);
    expect(phoneLanguage(dir)).toBe("es");
    expect((await run({ op: "status" })).isError).toBeUndefined();
  });
});
