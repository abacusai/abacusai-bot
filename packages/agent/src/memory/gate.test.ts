/**
 * The checks every note passes before it is written: one row per rule, so a
 * change that lets a secret, a failed search or a duplicate through fails here.
 */
import { describe, expect, it } from "vitest";

import {
  checkDraft,
  type Draft,
  looksSecret,
  SECRET_WITHHELD,
  secretWithheld,
  withholdSecrets,
} from "./gate.js";
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
// A random run with no provider prefix, and the same shapes ids and checksums take.
const randomRun = ["q7Lm2Xp9Rt4Vz8Kb", "3Hd6Wn1Ys5Fc0Ja", "8Tg2"].join("");
const driveId = ["1AbCdEf23GhIjK", "lMnO45pQrS6t", "UvWx78yZaBcDeFgH9i"].join(
  "-"
);
const md5 = ["0a1b2c3d4e5f", "6a7b8c9d0e1f", "2a3b4c5d"].join("");

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
    case: "a key and nothing else",
    draft: draft(`Stripe: ${fakeKey}`),
    refused: /password, key or code/,
  },
  {
    case: "a key under a label and nothing else",
    draft: draft(`Stripe:\n${fakeKey}`),
    refused: /password, key or code/,
  },
  {
    case: "a password said in plain words",
    draft: draft("Gmail password is sunshine"),
    refused: /password, key or code/,
  },
  {
    case: "a long note with a key inside it",
    draft: draft(
      `${"The shop's order flow: a customer pays on the site, the order goes to the sheet, and the packer prints the label. ".repeat(10)}Stripe test key ${fakeKey} sits in the vault.`
    ),
    refused: null,
  },
  {
    case: "a dated file name built from words",
    draft: draft(
      "Backup of the map is data/town_map_before_shops_20261102_093015.json."
    ),
    refused: null,
  },
  {
    case: "a UUID routine id",
    draft: draft(
      "The check-in routine is routine-6f1c2b7a-3d4e-4f50-8a1b-2c3d4e5f6a7b."
    ),
    refused: null,
  },
  {
    case: "a long note that mentions a missing branch in passing",
    draft: draft(
      "The shop site repo is github.com/example/shop-site, private. Stack: npm workspaces, React 19, Vite 7, Tailwind v4. The default branch main does not exist yet; work is on chore/skeleton."
    ),
    refused: null,
  },
  {
    case: "a rule-like fact that switches something off",
    draft: draft(
      "Pause rule for the auto-reply: when the owner replies in a chat himself, the bot stays quiet in that chat for 30 minutes, then answers again. A typed STOP is turned off after 5 minutes."
    ),
    refused: null,
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
    draft: draft("One more fact about the shop and its hours."),
    siblings: Array.from({ length: 12 }, (_, i) =>
      note(`fact-${i}`, `${i} `.repeat(120), "preference")
    ),
    refused: /memory is full/,
  },
  {
    case: "rules have their own room, as the standing instructions",
    draft: draft("One more rule about tone and greetings.", { type: "rule" }),
    siblings: Array.from({ length: 12 }, (_, i) =>
      note(`fact-${i}`, `${i} `.repeat(120), "preference")
    ),
    refused: null,
  },
  {
    case: "too many instructions",
    draft: draft("One more rule about tone and greetings.", { type: "rule" }),
    siblings: Array.from({ length: 40 }, (_, i) =>
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

  it("withholds a key inside a longer note but keeps the note and its ids", () => {
    const sheet = ["9xQ2mPz7Lk4Rt8Vb", "Wn3Ys6Hd1Jf5_Gc0Ae"].join("");
    const result = checkDraft({
      draft: draft(
        `The lead list is in leads/leads-2026-11-20.xlsx. Its Google Sheet copy has id ${sheet}. Stripe test key ${fakeKey} is in the vault.`
      ),
      siblings: [],
      updating: null,
      userWords: "",
      byUser: false,
      now: NOW,
    });
    expect(typeof result).toBe("object");
    const body = (result as Draft).body;
    expect(body).toContain("leads/leads-2026-11-20.xlsx");
    // An id the note names as one is how the sheet is found again.
    expect(body).toContain(sheet);
    expect(body).not.toContain(fakeKey);
  });

  it.each([
    {
      case: "a passphrase with spaces after its label",
      text: "Home WiFi is HomeNet-5G. WiFi password: purple monkey dishwasher.",
      gone: ["purple", "monkey", "dishwasher"],
      kept: ["HomeNet-5G"],
    },
    {
      case: "a quoted passphrase",
      text: 'Router admin user is admin. Password: "correct horse battery staple".',
      gone: ["horse", "staple"],
      kept: ["Router admin user is admin"],
    },
    {
      case: "a password said in words, the clause after it kept",
      text: "Netflix is the family account; password is hunter, shared with the kids.",
      gone: ["hunter"],
      kept: ["shared with the kids"],
    },
    {
      case: "a password, and where it is kept",
      text: "Router password: tiger lily in the drawer note, changed yearly.",
      gone: ["tiger", "lily"],
      kept: ["in the drawer note"],
    },
    {
      case: "a token in a URL's query",
      text: "The deploy hook is https://hooks.example.com/run?token=abc123def456&team=7 and posts to ops.",
      gone: ["abc123def456"],
      kept: ["&team=7 and posts to ops"],
    },
    {
      case: "a webhook secret in a URL's path",
      text: `Alerts go to https://chat.example.com/api/webhooks/123/${randomRun} for the ops room.`,
      gone: [randomRun],
      kept: ["for the ops room"],
    },
    {
      case: "a random run with nothing naming it",
      text: `Use ${randomRun} for the reporting service.`,
      gone: [randomRun],
      kept: ["for the reporting service"],
    },
  ])("withholds $case", ({ text, gone, kept }) => {
    const result = withholdSecrets(text);
    expect(result.withheld).toBeGreaterThan(0);
    expect(result.text).toContain(SECRET_WITHHELD);
    for (const part of gone) expect(result.text).not.toContain(part);
    for (const part of kept) expect(result.text).toContain(part);
  });

  it.each([
    [
      "a Drive id named as an id",
      `The lead list sheet (id ${driveId}) is shared with sales.`,
    ],
    [
      "a Drive id in a document URL",
      `Brief: https://docs.google.com/document/d/${driveId}/edit`,
    ],
    ["a checksum", `The installer matches the original (md5 ${md5}).`],
    ["a commit", `Fixed in commit ${md5}cafe12, merged Friday.`],
    [
      "a class name",
      "The bug is in InvoiceExportApplicationServicePostgresV2 at line 120.",
    ],
    [
      "a variable that holds the token",
      "The bot reads the token: GITHUB_TOKEN in deploy/.env.",
    ],
    [
      "a password described, not given",
      "The password is in the vault and the PIN is correct.",
    ],
    [
      "a dated backup name",
      "Backup at app.js.bak.before-cleanup-20261117T190027Z.",
    ],
  ])("keeps %s", (_, text) => {
    expect(withholdSecrets(text)).toEqual({ text, withheld: 0 });
  });

  it("reads a long run of punctuation after a label in linear time", () => {
    const text = `password: x${"!".repeat(50_000)}y`;
    const started = performance.now();
    withholdSecrets(text);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("keeps a long note and withholds only the key in it", () => {
    const flow =
      "The shop's order flow: a customer pays on the site, the order goes to the sheet, and the packer prints the label. ".repeat(
        10
      );
    const result = checkDraft({
      draft: draft(`${flow}Stripe test key ${fakeKey} sits in the vault.`),
      siblings: [],
      updating: null,
      userWords: "",
      byUser: false,
      now: NOW,
    }) as Draft;
    expect(result.body).toContain(flow.trim());
    expect(result.body).toContain(
      `Stripe test key ${SECRET_WITHHELD} sits in the vault.`
    );
    expect(result.body).not.toContain(fakeKey);
  });

  it("tells a secret it withheld from one already withheld", () => {
    const sent = draft(`Deploys use key ${fakeKey} from the team vault.`);
    const saved = checkDraft({
      draft: sent,
      siblings: [],
      updating: null,
      userWords: "",
      byUser: false,
      now: NOW,
    }) as Draft;
    expect(saved.body).not.toContain(fakeKey);
    expect(secretWithheld(sent)).toBe(true);
    // An update that carries a note's earlier placeholder withholds nothing new.
    expect(secretWithheld(draft(saved.body))).toBe(false);
  });

  it("refuses a key on the user's own edit", () => {
    const result = checkDraft({
      draft: draft(`The shop runs on Stripe. Key ${fakeKey}.`),
      siblings: [],
      updating: null,
      userWords: "",
      byUser: true,
      now: NOW,
    });
    expect(result).toMatch(/vault/);
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
    expect(looksSecret("The refresh token is dead, sign in again")).toBe(false);
    expect(looksSecret("Token-Streaming, chunked replies")).toBe(false);
    expect(
      looksSecret("Firmware file PUMP_V2__CTRL_B12_Main_ORI_20261012_214535")
    ).toBe(false);
  });
});
