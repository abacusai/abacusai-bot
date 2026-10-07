import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildOwnerTools, OWNER_TOOL_NAMES } from "../owner-tools.js";
import { ID_NUMBER_WITHHELD, redactIdNumbers } from "./id-numbers.js";
import { readTravelers, travelersPath } from "./traveler-store.js";
import {
  buildTravelerTool,
  isAffirmative,
  RecentUserText,
  userWords,
} from "./traveler-tool.js";

let home: string;
const previous = {
  home: process.env.ABACUSAI_BOT_HOME,
  audience: process.env.ABACUSAI_BOT_AUDIENCE,
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "traveler-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  for (const [key, value] of [
    ["ABACUSAI_BOT_HOME", previous.home],
    ["ABACUSAI_BOT_AUDIENCE", previous.audience],
  ] as const)
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  fs.rmSync(home, { recursive: true, force: true });
});

const ASHA = {
  action: "save",
  name: "Asha Rao",
  date_of_birth: "1990-04-02",
  email: "asha@example.com",
};

/** The tool and the conversation it reads the user's words from. */
const chat = (...earlier: string[]) => {
  const recent = new RecentUserText();
  for (const message of earlier) recent.note(message);
  return {
    tool: buildTravelerTool({ home, recentUserText: recent.read }),
    say: (text: string) => recent.note(text),
  };
};

const textOf = (result: { content: Array<{ text: string }> }) =>
  result.content[0]?.text ?? "";

const requestOf = (text: string): string =>
  /request_id "(R\d+)"/.exec(text)?.[1] ?? "";

describe("saving a traveler", () => {
  it("asks first, and saves only on the user's next message saying yes, in memories/travelers.json, owner-only", async () => {
    const { tool, say } = chat("yes", "book it for me");
    const asked = await tool.execute("c1", ASHA);
    // An earlier "yes" in the chat is not the answer: nothing is saved yet.
    expect(readTravelers(home)).toEqual([]);
    expect(textOf(asked)).toMatch(/Send the user exactly this question/);
    const request = requestOf(textOf(asked));
    expect(
      textOf(await tool.execute("c2", { action: "save", request_id: request }))
    ).toMatch(/has not answered yet/);

    say("yes please");
    const saved = await tool.execute("c3", {
      action: "save",
      request_id: request,
    });
    expect(saved.isError).toBeUndefined();
    expect(readTravelers(home)).toHaveLength(1);
    expect(readTravelers(home)[0]?.consent.quote).toBe("yes please");
    expect(travelersPath(home)).toBe(
      path.join(home, "memories", "travelers.json")
    );
    if (process.platform !== "win32")
      expect(fs.statSync(travelersPath(home)).mode & 0o777).toBe(0o600);
  });

  it("is refused when the next message does not say yes, and an old request is not answered by a later yes", async () => {
    const { tool, say } = chat();
    const request = requestOf(textOf(await tool.execute("c1", ASHA)));
    say("no, don't save anything");
    say("yes");
    const refused = await tool.execute("c2", {
      action: "save",
      request_id: request,
    });
    expect(refused.isError).toBe(true);
    expect(readTravelers(home)).toEqual([]);
    // The request is spent.
    expect(
      (await tool.execute("c3", { action: "save", request_id: request }))
        .isError
    ).toBe(true);
  });

  it("asks about the passport separately, answered by a later message of its own", async () => {
    const { tool, say } = chat();
    const first = requestOf(
      textOf(
        await tool.execute("c1", {
          ...ASHA,
          passport_number: "K1234567",
          passport_expiry: "2031-05-01",
        })
      )
    );
    expect(first).not.toBe("");
    say("yes");
    const details = textOf(
      await tool.execute("c2", { action: "save", request_id: first })
    );
    expect(details).toMatch(/Also keep Asha Rao's passport/);
    expect(details).not.toContain("K1234567");
    expect(readTravelers(home)[0]?.passport).toBeNull();

    // The same "yes" does not answer the passport question.
    const second = requestOf(details);
    expect(
      textOf(await tool.execute("c3", { action: "save", request_id: second }))
    ).toMatch(/has not answered yet/);
    say("yes, the passport too");
    await tool.execute("c4", { action: "save", request_id: second });
    const [traveler] = readTravelers(home);
    expect(traveler?.passport?.number).toBe("K1234567");
    expect(traveler?.passportConsent?.quote).toBe("yes, the passport too");
  });

  it("never shows the model a passport number, and forgets just the passport or everything", async () => {
    const { tool, say } = chat();
    let text = textOf(
      await tool.execute("c1", { ...ASHA, passport_number: "K1234567" })
    );
    say("yes");
    text = textOf(
      await tool.execute("c2", { action: "save", request_id: requestOf(text) })
    );
    say("yes");
    text = textOf(
      await tool.execute("c3", { action: "save", request_id: requestOf(text) })
    );
    expect(text).not.toContain("K1234567");
    const listed = textOf(await tool.execute("c4", { action: "get" }));
    expect(listed).toMatch(/t1: Asha Rao, born 1990-04-02/);
    expect(listed).toMatch(/passport ••••67 saved/);
    expect(listed).not.toContain("1234567");

    await tool.execute("c5", { action: "forget", id: "t1", field: "passport" });
    expect(readTravelers(home)[0]?.passport).toBeNull();
    await tool.execute("c6", { action: "forget", id: "t1" });
    expect(readTravelers(home)).toEqual([]);
  });
});

describe("the user's words", () => {
  it("leave out what the host added: notes, links, routines", () => {
    expect(
      userWords(
        "yes\n\n[note] The vault page for akasaair.com was completed.\n\n[linked] connected"
      )
    ).toEqual(["yes"]);
  });

  it("are numbered in order, keeping only the last few", () => {
    const recent = new RecentUserText(2);
    recent.note("one");
    recent.note("two");
    recent.note("yes");
    expect(recent.read()).toEqual([
      { seq: 2, text: "two" },
      { seq: 3, text: "yes" },
    ]);
    expect(isAffirmative("yes")).toBe(true);
    expect(isAffirmative("no, don't")).toBe(false);
  });
});

describe("who gets the traveler tool", () => {
  it("only the user's own conversations, as the desktop says", () => {
    const recentUserText = new RecentUserText();
    delete process.env.ABACUSAI_BOT_AUDIENCE;
    expect(buildOwnerTools({ recentUserText })).toEqual([]);
    for (const audience of ["sender", "routine", ""]) {
      process.env.ABACUSAI_BOT_AUDIENCE = audience;
      expect(buildOwnerTools({ recentUserText }), audience).toEqual([]);
    }
    process.env.ABACUSAI_BOT_AUDIENCE = "owner";
    expect(
      buildOwnerTools({ recentUserText }).map((tool) => tool.name)
    ).toEqual(OWNER_TOOL_NAMES);
  });
});

describe("ID numbers in remembered text", () => {
  it("are withheld, labelled or by their shape", () => {
    for (const text of [
      "Passport number K1234567, expires 2031",
      "her passport number is 123456789",
      "UK passport no. 987654321",
      "Aadhaar: 1234 5678 9012",
      "PAN ABCDE1234F",
      "card 4242 4242 4242 4242 for flights",
      "SSN 123-45-6789",
      "ssn is 123456789",
      "US passport A12345678",
    ]) {
      const redacted = redactIdNumbers(text);
      expect(redacted, text).toContain(ID_NUMBER_WITHHELD);
      expect(redacted, text).not.toMatch(
        /\d{4}\s?\d{4}|\d{9}|K1234567|ABCDE1234F|A12345678/
      );
    }
  });

  it("leave phone numbers, dates, amounts, flights and plain words alone", () => {
    for (const text of [
      "Wife's number is +91 98765 43210",
      "Flying AI202 on 2026-10-09",
      "Gmail account connected on 3 Oct",
      "Booking reference X7Y2KQ",
      "Paid ₹123456789.00 last year",
    ])
      expect(redactIdNumbers(text)).toBe(text);
  });
});
