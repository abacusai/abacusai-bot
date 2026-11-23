/**
 * What a WhatsApp chat's new personal agent is sent of the bot's memory:
 * the owner's notes and custom instructions from a real memory folder under
 * a temp `ABACUSAI_BOT_HOME`, secrets dropped, capped; and how the post
 * answers the server's statuses.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { commit, type Note, noteWrite } from "@abacus-ai/agent/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {} }));

import {
  handoverPayload,
  instructionsText,
  ownerMemoryText,
  postHandoverMemory,
} from "./handover-memory";
import { saveNote } from "./memory-service";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "handover-memory-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

/** Shaped like a key, built from parts so no scanner takes it for one. */
const FAKE_KEY = ["sk", "proj", "Q7w8E9r0T1y2U3i4O5p6A7s8D9f0"].join("-");
const FAKE_PASSWORD = ["hunter", "42", "x"].join("");

const note = (over: Partial<Note>): Note => ({
  scope: { kind: "you" },
  name: "n",
  description: "",
  type: "fact",
  body: "",
  updated: "2026-11-01",
  by: "chat",
  ...over,
});

describe("the owner's memory as sent", () => {
  it("reads the about-you notes, leaves rules to the instructions, and drops secret lines", async () => {
    await saveNote({
      scope: "you",
      type: "profile",
      description: "Lives in Lisbon",
      text: "Lives in Lisbon and works as a nurse.",
    });
    // The save gate refuses secrets; a note from before it, or edited by
    // hand, can still hold one.
    await commit({ by: "you" }, () => ({
      writes: [
        noteWrite(
          note({
            name: "home-wifi",
            description: "Home wifi",
            body: `Router is in the hall.\nwifi password: ${FAKE_PASSWORD}`,
          })
        ),
        noteWrite(
          note({
            name: "old-key",
            type: "reference",
            description: "Old key",
            body: `Their key ${FAKE_KEY}`,
          })
        ),
      ],
      value: null,
    }));
    await saveNote({
      scope: "you",
      type: "rule",
      text: "Always reply in Portuguese.",
    });

    const payload = handoverPayload(true);
    expect(payload.memory).toContain("Lives in Lisbon and works as a nurse.");
    expect(payload.memory).toContain("Router is in the hall.");
    expect(payload.memory).not.toContain(FAKE_PASSWORD);
    expect(payload.memory).not.toContain(FAKE_KEY);
    expect(payload.memory).not.toContain("Always reply in Portuguese.");
    expect(payload.instructions).toBe("Always reply in Portuguese.");
  });

  it("sends no memory when the user turned memory off, and still the instructions", async () => {
    await saveNote({
      scope: "you",
      type: "fact",
      description: "Has a dog",
      text: "Has a dog called Rex.",
    });
    await saveNote({ scope: "you", type: "rule", text: "Keep it short." });
    expect(handoverPayload(false)).toEqual({
      memory: "",
      instructions: "Keep it short.",
    });
  });

  it("is empty for a user with nothing saved", () => {
    expect(handoverPayload(true)).toEqual({ memory: "", instructions: "" });
  });

  it("keeps the newest notes under the cap and leaves expired status notes behind", () => {
    const text = ownerMemoryText(
      [
        note({ name: "old", body: "old ".repeat(30), updated: "2026-01-01" }),
        note({ name: "new", body: "Newest fact.", updated: "2026-11-20" }),
        note({ name: "mid", body: "Middle fact.", updated: "2026-06-01" }),
        note({
          name: "gone",
          type: "status",
          body: "Travelling this week.",
          updated: "2026-11-21",
          expires: "2026-11-10",
        }),
      ],
      new Date("2026-11-23T12:00:00Z"),
      80
    );
    expect(text).toContain("Newest fact.");
    expect(text).toContain("Middle fact.");
    expect(text).not.toContain("old old");
    expect(text).not.toContain("Travelling");
    expect(text.indexOf("Newest")).toBeLessThan(text.indexOf("Middle"));
    expect(text.length).toBeLessThanOrEqual(80);
  });

  it("cuts the instructions at a whole line under the cap", () => {
    const text = instructionsText("one\ntwo\nthree", 8);
    expect(text).toBe("one\ntwo");
  });
});

describe("posting the memory", () => {
  const payload = { memory: "Has a dog.", instructions: "Keep it short." };
  const answers = (...statuses: Array<number | Error>) => {
    const fetchImpl = vi.fn(async () => {
      const next = statuses.shift()!;
      if (next instanceof Error) throw next;
      return new Response(next === 200 ? '{"status":"ok"}' : '{"error":"x"}', {
        status: next,
      });
    });
    return fetchImpl;
  };
  const post = (fetchImpl: ReturnType<typeof answers>) =>
    postHandoverMemory(payload, {
      url: "https://api.example/v1/abacusaibot_handover_memory",
      key: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      delaysMs: [0, 0],
    });

  it("posts the JSON body with the key as a bearer", async () => {
    const fetchImpl = answers(200);
    await expect(post(fetchImpl)).resolves.toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.example/v1/abacusaibot_handover_memory");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-key"
    );
    expect(JSON.parse(String(init.body))).toEqual(payload);
  });

  it("stops at 404 (no agent took the chat) and 403 (a wrong key)", async () => {
    for (const status of [404, 403]) {
      const fetchImpl = answers(status);
      await expect(post(fetchImpl)).resolves.toEqual({
        ok: false,
        reason: `http-${status}`,
        retryable: false,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("tries again after a network or server error, a couple of times", async () => {
    const recovers = answers(new TypeError("fetch failed"), 502, 200);
    await expect(post(recovers)).resolves.toEqual({ ok: true });
    expect(recovers).toHaveBeenCalledTimes(3);

    const down = answers(500, 500, 500, 200);
    await expect(post(down)).resolves.toMatchObject({
      ok: false,
      reason: "http-500",
    });
    expect(down).toHaveBeenCalledTimes(3);
  });

  it("sends nothing without a key", async () => {
    const fetchImpl = answers(200);
    await expect(
      postHandoverMemory(payload, {
        key: "",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).resolves.toMatchObject({ ok: false, reason: "no-key" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
