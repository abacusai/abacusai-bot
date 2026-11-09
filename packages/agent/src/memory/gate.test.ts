/**
 * The checks every note passes before it is written: one row per rule, so a
 * change that lets a secret, a failed search or a duplicate through fails here.
 */
import { describe, expect, it } from "vitest";

import { checkDraft, type Draft, looksSecret } from "./gate.js";
import type { Note } from "./notes.js";

const NOW = new Date("2026-11-09T12:00:00Z");

const note = (
  name: string,
  body: string,
  type: Note["type"] = "fact"
): Note => ({
  scope: { kind: "you" },
  name,
  description: body.slice(0, 60),
  type,
  body,
  updated: "2026-11-01",
  by: "chat",
});

const draft = (body: string, extra: Partial<Draft> = {}): Draft => ({
  name: "a-note",
  description: "",
  type: "fact",
  body,
  ...extra,
});

// Built from parts so no credential-shaped literal sits in the source.
const fakeKey = ["sk", "proj", "A1b2C3d4E5f6G7h8I9j0K1"].join("-");

const ROWS: Array<{
  case: string;
  draft: Draft;
  siblings?: Note[];
  updating?: string | null;
  userWords?: string;
  byUser?: boolean;
  refused: RegExp | null;
}> = [
  {
    case: "a plain fact",
    draft: draft("Runs a bakery in Pune with two staff."),
    refused: null,
  },
  {
    case: "an API key",
    draft: draft(`The key is ${fakeKey}`),
    refused: /password, key or code/,
  },
  {
    case: "a PIN said in words",
    draft: draft("Shop admin PIN: 4821"),
    refused: /password, key or code/,
  },
  {
    case: "a passphrase",
    draft: draft("Authorisation passphrase is bluemango77"),
    refused: /password, key or code/,
  },
  {
    case: "a failed search as a fact",
    draft: draft("The file config.yaml doesn't exist in the bot folder."),
    refused: /not a fact/,
  },
  {
    case: "the user said it is gone",
    draft: draft("The old config.yaml does not exist any more."),
    userWords: "fyi the old config.yaml does not exist any more, I deleted it",
    refused: null,
  },
  {
    case: "live state",
    draft: draft("The five WhatsApp routines are paused."),
    refused: /read live/,
  },
  {
    case: "not connected",
    draft: draft("Slack is not connected, stop asking."),
    refused: /read live/,
  },
  {
    case: "a rule with never",
    draft: draft("Never message clients after 9pm.", { type: "rule" }),
    refused: null,
  },
  {
    case: "status without expiry",
    draft: draft("Waiting on the printer's quote.", { type: "status" }),
    refused: /expires/,
  },
  {
    case: "status too long",
    draft: draft("Waiting on the printer's quote.", {
      type: "status",
      expires: "2026-12-31",
    }),
    refused: /14 days/,
  },
  {
    case: "status within two weeks",
    draft: draft("Waiting on the printer's quote.", {
      type: "status",
      expires: "2026-11-15",
    }),
    refused: null,
  },
  {
    case: "a name already taken",
    draft: draft("Lives in Lisbon now."),
    siblings: [note("a-note", "Lives in Porto.")],
    refused: /Use action "update"/,
  },
  {
    case: "a restatement of another note",
    draft: draft("Prefers short replies without bullet points.", {
      name: "short-replies-2",
    }),
    siblings: [
      note(
        "short-replies",
        "Prefers short replies without bullet points please.",
        "preference"
      ),
    ],
    refused: /restates the note "short-replies"/,
  },
  {
    case: "an update of the same note",
    draft: draft("Prefers short replies, no bullet points, no emoji.", {
      name: "short-replies",
      type: "preference",
    }),
    siblings: [
      note(
        "short-replies",
        "Prefers short replies without bullet points.",
        "preference"
      ),
    ],
    updating: "short-replies",
    refused: null,
  },
  { case: "too long", draft: draft("x ".repeat(900)), refused: /holds 1500/ },
  {
    case: "a full scope",
    draft: draft("One more rule about tone and greetings.", { type: "rule" }),
    siblings: Array.from({ length: 12 }, (_, i) =>
      note(`rule-${i}`, `${i} `.repeat(120), "rule")
    ),
    refused: /memory is full/,
  },
  {
    case: "the user's own edit of a state",
    draft: draft("The weekly report routine is paused until January."),
    byUser: true,
    refused: null,
  },
];

describe("checkDraft", () => {
  it.each(ROWS)("$case", (row) => {
    const result = checkDraft({
      draft: row.draft,
      siblings: row.siblings ?? [],
      updating: row.updating ?? null,
      userWords: row.userWords ?? "",
      byUser: row.byUser ?? false,
      now: NOW,
    });
    if (row.refused == null) expect(typeof result).toBe("object");
    else expect(result).toMatch(row.refused);
  });

  it("withholds ID numbers but keeps the note", () => {
    const result = checkDraft({
      draft: draft("Passport number is K1234567 for the Goa trip."),
      siblings: [],
      updating: null,
      userWords: "",
      byUser: false,
      now: NOW,
    });
    expect(typeof result).toBe("object");
    expect((result as Draft).body).not.toContain("K1234567");
  });

  it("fills a missing description from the first sentence", () => {
    const result = checkDraft({
      draft: draft("Works nights. Sleeps until noon."),
      siblings: [],
      updating: null,
      userWords: "",
      byUser: false,
      now: NOW,
    }) as Draft;
    expect(result.description).toBe("Works nights.");
  });

  it("does not take ordinary words for secrets", () => {
    expect(looksSecret("The token budget for the event is tight")).toBe(false);
    expect(looksSecret("Prefers the secret menu at Cafe Rio")).toBe(false);
  });
});
