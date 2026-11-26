/**
 * The checks every note passes before it is written: one row per rule, so a
 * change that lets a secret, a failed search or a duplicate through fails here.
 */
import { describe, expect, it } from "vitest";

import { redactIdNumbers } from "../traveler/id-numbers.js";
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
/** What a placeholder from elsewhere looks like; the gate never writes one. */
const PLACEHOLDER = "[secret withheld]";

// Fake keys made at run time from a fixed seed: none sits in the source.
let seed = 20_261_126;
const random = (): number => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
  return seed / 2 ** 31;
};
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();
const DIGITS = "0123456789";
const ALPHABETS = {
  base62: UPPER + LOWER + DIGITS,
  lower36: LOWER + DIGITS,
  upper36: UPPER + DIGITS,
  hex: "0123456789abcdef",
  base64url: `${UPPER}${LOWER}${DIGITS}-_`,
  base64: `${UPPER}${LOWER}${DIGITS}+/`,
};
/** A PEM armour line, built from parts so no key header sits in the source. */
const pem = (edge: "BEGIN" | "END", kind: string): string =>
  ["-----", edge, " ", kind, kind ? " " : "", "PRIVATE KEY-----"].join("");
/** A key half that mixes upper case, lower case and digits, as random keys do. */
const mixed = (length: number): string =>
  Array.from({ length }, (_, at) =>
    fake([UPPER, LOWER, DIGITS][at % 3]!, 1)
  ).join("");
const fake = (alphabet: string, length: number): string =>
  Array.from(
    { length },
    () => alphabet[Math.floor(random() * alphabet.length)]
  ).join("");

/** The patterns the gate has always refused on: what it detects now must cover them. */
const EARLIER_GATE: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\b(?:password|passwd|passcode|passphrase|pass phrase|pin|pin code|api[ _-]?key|access[ _-]?key|secret|token|otp|security code)\b\s*(?:is|was|=|:|-)\s*["'`]?[^\s"'`]{3,}/i,
  /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z_-]*\d)(?=[0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/,
];
const earlierGateRefuses = (text: string): boolean =>
  EARLIER_GATE.some((pattern) => pattern.test(text));
/** Whether the earlier gate refused this note: its patterns over the note with ID numbers withheld, as checkDraft reads it. */
const earlierGateRefusesNote = (text: string): boolean =>
  earlierGateRefuses(redactIdNumbers(text));

const check = (body: string, byUser = false) =>
  checkDraft({
    draft: draft(body),
    siblings: [],
    updating: null,
    userWords: "",
    byUser,
    now: NOW,
  });

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
    case: "a key inside a longer note",
    draft: draft(
      `The shop runs on Stripe with key ${fakeKey}; the payouts go out on Mondays.`
    ),
    refused: /password, key or code/,
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
    case: "a failed search listed across places",
    draft: draft(
      "Acme invoice not found in Gmail, Drive, Dropbox, OneDrive, Outlook, Notion, Slack, the shared team folder or the downloads folder"
    ),
    refused: /not a fact/,
  },
  {
    case: "states listed in one sentence",
    draft: draft(
      "Status of tools: Gmail is connected, Slack disconnected, Notion connected, Drive connected, Calendar connected, routines running"
    ),
    refused: /read live/,
  },
  {
    case: "states listed with semicolons",
    draft: draft(
      "Gmail is connected; Slack is connected; Notion is connected; Drive is connected; Calendar is connected."
    ),
    refused: /read live/,
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

  const checkParts = (
    parts: { description?: string; body: string; keywords?: string },
    byUser = false
  ) =>
    checkDraft({
      draft: draft(parts.body, {
        description: parts.description ?? "",
        ...(parts.keywords != null ? { keywords: parts.keywords } : {}),
      }),
      siblings: [],
      updating: null,
      userWords: "",
      byUser,
      now: NOW,
    });

  // Every secret, wherever it sits in a note, refuses the whole note.
  const { base62, upper36, hex, base64url, base64 } = ALPHABETS;
  const awsSecret = `${fake(base62, 18)}/${fake(base62, 10)}+${fake(base62, 10)}`;
  const uuid = [8, 4, 4, 4, 12].map((n) => fake(hex, n)).join("-");
  const stripeLive = `sk_live_${fake(base62, 24)}`;
  const CREDENTIALS: Array<[string, string, string[]]> = [
    [
      "a project key",
      (() => {
        const k = `sk-proj-${fake(base62, 48)}`;
        return `OpenAI key ${k}|${k}`;
      })(),
      [],
    ],
    [
      "an AWS key pair",
      `AWS ${"AKIA" + fake(upper36, 16)} secret ${awsSecret}`,
      [awsSecret],
    ],
    [
      "an AWS secret after its env name",
      `aws_secret_access_key = ${awsSecret}`,
      [awsSecret],
    ],
    [
      "an AWS secret with no symbols",
      (() => {
        const k = fake(base62, 40);
        return `AWS secret ${k}|${k}`;
      })(),
      [],
    ],
    [
      "a GCP key id",
      (() => {
        const k = fake(hex, 40);
        return `GCP service account private_key_id ${k}|${k}`;
      })(),
      [],
    ],
    [
      "a PEM body with no end line",
      (() => {
        const k = fake(base64, 64);
        return `GCP json "private_key": "${pem("BEGIN", "")}\n${k}|${k}`;
      })(),
      [],
    ],
    [
      "an RSA block",
      (() => {
        const k = fake(base64, 64);
        return `${pem("BEGIN", "RSA")}\n${k}\n${pem("END", "RSA")}|${k}`;
      })(),
      [],
    ],
    [
      "a PGP block",
      (() => {
        const k = fake(base64, 64);
        return `${pem("BEGIN", "PGP").replace("KEY-----", "KEY BLOCK-----")}\n${k}|${k}`;
      })(),
      [],
    ],
    ["a Stripe live key", `Stripe live ${stripeLive}`, [stripeLive]],
    [
      "a webhook signing secret",
      (() => {
        const k = `whsec_${fake(base62, 32)}`;
        return `Stripe webhook signing ${k}|${k}`;
      })(),
      [],
    ],
    [
      "a Slack app token",
      (() => {
        const k = `xapp-1-${fake(upper36, 11)}-${fake(DIGITS, 13)}-${fake(hex, 64)}`;
        return `Slack app token ${k}|${k}`;
      })(),
      [],
    ],
    [
      "a JWT",
      (() => {
        const k = `eyJ${fake(base64url, 17)}.${fake(base64url, 30)}.${fake(base64url, 30)}`;
        return `JWT ${k}|${k}`;
      })(),
      [],
    ],
    [
      "a base64 blob",
      (() => {
        const k = `${fake(base62, 20)}+${fake(base62, 10)}/${fake(base62, 9)}`;
        return `base64 blob ${k}|${k}`;
      })(),
      [],
    ],
    [
      "a key of mostly letters",
      (() => {
        const k = `${fake(LOWER, 20)}7${fake(LOWER, 19)}`;
        return `mostly-letters key ${k}|${k}`;
      })(),
      [],
    ],
    [
      "a SendGrid key",
      (() => {
        const a = fake(base64url, 22);
        const b = fake(base64url, 43);
        return `SendGrid SG.${a}.${b}|${a}|${b}`;
      })(),
      [],
    ],
    ["a UUID-shaped key", `Heroku key ${uuid}`, [uuid]],
    [
      "a Mailchimp key",
      (() => {
        const k = fake(hex, 32);
        return `Mailchimp ${k}-us21|${k}`;
      })(),
      [],
    ],
    [
      "an OAuth refresh token",
      (() => {
        const k = fake(base64url, 60);
        return `Google OAuth refresh 1//0${k}|${k}`;
      })(),
      [],
    ],
    [
      "a Telegram bot token",
      (() => {
        const k = fake(base64url, 33);
        return `Telegram bot token ${fake(DIGITS, 10)}:AA${k}|${k}`;
      })(),
      [],
    ],
    [
      "a Discord bot token",
      (() => {
        const a = fake(base62, 23);
        const b = fake(base64url, 27);
        return `Discord bot token M${a}.${fake(base64url, 6)}.${b}|${a}|${b}`;
      })(),
      [],
    ],
    [
      "an Azure account key",
      (() => {
        const k = `${fake(base62, 40)}+${fake(base62, 20)}/${fake(base62, 25)}`;
        return `Azure storage AccountKey=${k}==|${k}`;
      })(),
      [],
    ],
    [
      "a DigitalOcean token",
      (() => {
        const k = fake(hex, 64);
        return `DigitalOcean dop_v1_${k}|${k}`;
      })(),
      [],
    ],
    [
      "a password said in words",
      "the password is hunter2 for the router",
      ["hunter2"],
    ],
    [
      "a password after a describing word",
      "my password is the dog's name Rex1987",
      ["Rex1987"],
    ],
    [
      "a password after 'the word'",
      "password is the word sunshine42",
      ["sunshine42"],
    ],
    [
      "a passphrase in words",
      "the wifi password is fall in love forever",
      ["fall", "love forever"],
    ],
    [
      "a passphrase after a colon",
      "password: correct horse battery staple",
      ["horse battery staple"],
    ],
    [
      "a password after '=' with a symbol",
      "gmail password = Tr0ub4dor&3",
      ["Tr0ub4dor", "&3"],
    ],
    ["a PIN after a hyphen", "pin-4821 debit card", ["4821"]],
    [
      "a password after a hyphen",
      "password-Hunter22 is for gmail",
      ["Hunter22"],
    ],
    [
      "a password after 'still'",
      "the gmail password is still Hunter2024",
      ["Hunter2024"],
    ],
    [
      "a password on the next line",
      "password:\nhunter2 for router",
      ["hunter2"],
    ],
    ["a password in capitals", "Password is HUNTER_TWO_X", ["HUNTER_TWO_X"]],
    [
      "a password after a variable",
      "passphrase is ${DB_PASSWORD} actually Xy9",
      ["Xy9"],
    ],
    [
      "a key of letters only",
      "api key is abcdefghijklmnopqrstuv",
      ["abcdefghijklmnopqrstuv"],
    ],
    [
      "a token after '='",
      "token = abcdefghijklmnopqrstuv",
      ["abcdefghijklmnopqrstuv"],
    ],
    [
      "an access key in capitals",
      "the access key is ABCDEFGHIJKLMNOP",
      ["ABCDEFGHIJKLMNOP"],
    ],
    ["a one-time code", "OTP is 482193 from the bank", ["482193"]],
    ["an env line", "PASSWORD=hunter2", ["hunter2"]],
    [
      "a webhook in a URL path",
      (() => {
        const k = fake(base64url, 68);
        return `https://discord.com/api/webhooks/${fake(DIGITS, 18)}/${k}|${k}`;
      })(),
      [],
    ],
    [
      "a Slack webhook",
      (() => {
        const k = fake(base62, 24);
        return `https://hooks.slack.com/services/T${fake(upper36, 8)}/B${fake(upper36, 8)}/${k}|${k}`;
      })(),
      [],
    ],
    [
      "a signed URL",
      (() => {
        const k = fake(hex, 64);
        return `https://acme.s3.amazonaws.com/a.pdf?X-Amz-Algorithm=AWS4&X-Amz-Signature=${k}|${k}`;
      })(),
      [],
    ],
    [
      "a key after a hyphen (aws-)",
      (() => {
        const k = `AKIA${fake(upper36, 16)}`;
        return `Billing role uses aws-${k} for the uploads bucket|${k}`;
      })(),
      [],
    ],
    [
      "a Slack token after a hyphen",
      (() => {
        const k = `xoxb-${fake(DIGITS, 5)}-${fake(base62, 10)}`;
        return `Slack bot uses slack-${k} for the ops channel|${k}`;
      })(),
      [],
    ],
    [
      "a project key after a hyphen",
      (() => {
        const k = `sk-${fake(base62, 20)}`;
        return `Stripe test key test-${k} for the shop checkout|${k}`;
      })(),
      [],
    ],
    [
      "a Google key after a hyphen",
      (() => {
        const k = `AIza${fake(base64url, 35)}`;
        return `Google key maps-${k} for the store page|${k}`;
      })(),
      [],
    ],
    [
      "a JWT after a hyphen",
      (() => {
        const k = `eyJ${fake(base64url, 16)}.${fake(base64url, 16)}.${fake(base64url, 6)}`;
        return `JWT for staging is tok-${k} for the api tests|${k}`;
      })(),
      [],
    ],
    [
      "a password written after a placeholder",
      `password is ${PLACEHOLDER} hunter2 for the router in the hall`,
      ["hunter2"],
    ],
    [
      "a PIN written after a placeholder",
      `PIN: ${PLACEHOLDER} 4821 for the debit card in the wallet`,
      ["4821"],
    ],
    [
      "a token written after a placeholder",
      (() => {
        const k = mixed(20);
        return `token = ${PLACEHOLDER} ${k} for the router in the hall|${k}`;
      })(),
      [],
    ],
    [
      "a key written in the sentence after a placeholder",
      (() => {
        const k = mixed(20);
        return `api key: ${PLACEHOLDER}. The real one is ${k} for the router|${k}`;
      })(),
      [],
    ],
    [
      "an AWS pair split by words",
      (() => {
        const k = mixed(20);
        return `AWS access key AKIA${fake(upper36, 16)} for the billing role, its secret being ${k} for uploads|${k}`;
      })(),
      [],
    ],
    [
      "a key pair split across a long sentence",
      (() => {
        const k = mixed(20);
        return `Stripe pk_live_${fake(base62, 18)} is the publishable one and the restricted one we got later is ${k} for uploads|${k}`;
      })(),
      [],
    ],
    [
      "a key split by a zero-width space",
      (() => {
        const a = fake(base62, 20);
        const b = fake(base62, 20);
        return `OpenAI key sk-${a}​${b} for the router|${a}|${b}`;
      })(),
      [],
    ],
    [
      "an AWS key split by a zero-width joiner",
      (() => {
        const a = fake(upper36, 8);
        const b = fake(upper36, 8);
        return `AWS AKIA${a}‍${b}|${a}‍${b}|${b}`;
      })(),
      [],
    ],
    [
      "a label split by a zero-width space",
      "pass​word is hunter2 for the router",
      ["hunter2"],
    ],
    ...["­", "͏", "᠎", "⁡", "⁤"].map((mark): [string, string, string[]] => {
      const a = fake(base62, 20);
      const b = fake(base62, 20);
      return [
        `a key split by U+${mark.charCodeAt(0).toString(16)}`,
        `OpenAI key sk-${a}${mark}${b} for the router`,
        [a, b],
      ];
    }),
    ...["‐", "‑", "−", "﹣"].map((dash): [string, string, string[]] => {
      const k = fake(base62, 40);
      return [
        `a key after a U+${dash.charCodeAt(0).toString(16)} dash`,
        `OpenAI key sk${dash}${k} for the router`,
        [k],
      ];
    }),
    [
      "a label split by a soft hyphen",
      "pass­word is hunter2 for the router in the hall",
      ["hunter2"],
    ],
    (() => {
      const a = fake(base62, 20);
      const b = mixed(20);
      return [
        "a key wrapped onto the next line",
        `OpenAI key sk-${a}\n${b} for the router`,
        [a, b],
      ];
    })(),
    (() => {
      const b = mixed(17);
      return [
        "a Stripe key wrapped after more words",
        `Stripe key sk_live_${fake(base62, 16)}\nnext line ${b}`,
        [b],
      ];
    })(),
    [
      "a label in full-width letters",
      "ｐａｓｓｗｏｒｄ: hunter2 for the router",
      ["hunter2"],
    ],
    ...["catch/123", "reset", "invite", "s", "download"].map(
      (path): [string, string, string[]] => {
        const k = fake(base62, 40);
        return [
          `a capability URL (/${path}/)`,
          `https://example.com/${path}/${k}`,
          [k],
        ];
      }
    ),
    [
      "a private calendar feed",
      (() => {
        const k = fake(hex, 32);
        return `https://calendar.google.com/calendar/ical/x%40gmail.com/private-${k}/basic.ics|${k}`;
      })(),
      [],
    ],
    [
      "an IFTTT key",
      (() => {
        const k = fake(base62, 22);
        return `https://maker.ifttt.com/trigger/x/with/key/${k}|${k}`;
      })(),
      [],
    ],
    ...[
      "id",
      "checksum",
      "commit",
      "zone",
      "hash:",
      "sha256",
      "app id",
      "The api id is",
    ].map((word): [string, string, string[]] => {
      const k = word === "checksum" ? stripeLive : fake(base62, 40);
      return [`a key after "${word}"`, `${word} ${k}`, [k]];
    }),
  ].map((row): [string, string, string[]] => {
    const [name, text, secrets] = row as [string, string, string[]];
    // "said|secret|secret": the text, then the parts that must not be stored.
    const [said, ...parts] = text.split("|");
    return [name, said!, [...secrets, ...parts]];
  });

  it.each(CREDENTIALS)(
    "refuses a note holding %s, on both paths",
    (_, text) => {
      for (const byUser of [false, true])
        expect(
          check(`Work setup for the Acme billing project: ${text}`, byUser)
        ).toMatch(/password, key or code/);
    }
  );

  it.each([
    "Home WiFi is HomeNet-5G. WiFi password: purple monkey dishwasher.",
    "Netflix is the family account; password is hunter, shared with the kids.",
    "Gmail password: hunter2. Also 4821 for the work laptop.",
    "Recovery phrase: abandon ability able about above absent, kept offline.",
    "The card CVV is 123, for the family account.",
    "ｐａｓｓｗｏｒｄ: hunter2 for the router.",
    "pass​word is hunter2 for the router.",
    "pass­word is hunter2 for the router.",
    `OpenAI key sk-${fake(base62, 20)}­${fake(base62, 20)} for the router.`,
    `AWS secret ${fake(base62, 18)}/${fake(base62, 10)}+${fake(base62, 10)} for the billing role.`,
    `Billing role uses aws-AKIA${fake(upper36, 16)} for the uploads bucket.`,
    "DB_PASSWORD=hunter2 in the deploy env.",
    `${pem("BEGIN", "RSA")} is the header of the deploy key.`,
  ])(
    "refuses a person's secret, a disguised one or a key, on both paths: %s",
    (text) => {
      for (const byUser of [false, true])
        expect(check(text, byUser)).toMatch(/password, key or code/);
    }
  );

  it.each([
    [
      {
        description: "Gmail password:",
        body: "hunter2. Shared with the family, rotated yearly.",
      },
    ],
    [
      {
        description: "Router setup",
        body: "The hall router password is",
        keywords: "hunter2",
      },
    ],
    [{ description: "Stripe API", body: "key:", keywords: mixed(20) }],
    [{ description: "Wifi", body: "pass\nphrase: purple monkey dishwasher" }],
  ])("refuses a secret split from its label across the parts: %j", (parts) => {
    for (const byUser of [false, true])
      expect(checkParts(parts, byUser)).toMatch(/password, key or code/);
  });

  it.each([
    "The Gmail password — stored in 1Password — is shared with the family.",
    "The API key – the one for billing – lives in the vault for the team.",
    "Rotate the token — every 90 days — per the security policy for the team.",
    "The private key - ed25519 - is on the build box for deploys.",
    "The SSH private key lives in ~/.ssh/id_ed25519 on the build box.",
    "Our API key is in the .env file on the server, never in git.",
    "Drive folder Clients/Acme/Contracts/2026/Signed/FinalVersions holds the signed contracts.",
    `Drive folder Clients/Acme/${mixed(20)}/Contracts holds the billing files.`,
    `Drive folder Clients/Acme/${mixed(28)}/Contracts holds the billing files.`,
    "Project lives in src/components/Dashboard/Widgets/RevenueChart2/index.tsx and renders the main chart.",
    `The rule: ${"-".repeat(1_001)}`,
    `Long hyphenated slug ${"word-".repeat(250)}end`,
    "Ｐｒｏｊｅｃｔ codename is Ｂｌｕｅ and the deadline is ① week from Friday.",
    "The token budget for the event is tight.",
  ])("keeps a note with no secret as written, on both paths: %s", (text) => {
    expect(earlierGateRefuses(text)).toBe(false);
    for (const byUser of [false, true])
      expect(check(text, byUser)).toMatchObject({ body: text });
  });

  it("refuses whatever the earlier patterns refuse, in fuzzed text, on both paths", () => {
    const pieces = [
      "password",
      "PIN",
      "pin code",
      "otp",
      "token",
      "secret",
      "api key",
      "access-key",
      "passphrase",
      "pass phrase",
      "security code",
      "passcode",
      "passwd",
      " is ",
      " was ",
      "=",
      ":",
      "-",
      " - ",
      '"',
      "'",
      "`",
      " ",
      "\n",
      "abc",
      "hunter2",
      "sk-",
      "ghp_",
      "xoxb-",
      "AKIA",
      "eyJ",
      "bearer ",
      "Ab3Cd5Ef7Gh9Jk2Lm4Np",
      "1234567890abcdef1234567890abcdef",
      "_",
      "é",
      "—",
      ".",
      ",",
      "(",
      ")",
      "/",
      "+",
      "%3D",
      "​",
      "­",
      "IS",
      "Password",
      PLACEHOLDER,
      " in ",
      " stored in ",
      "~/",
      "./",
      ".ts",
      "ｓｋ",
      "：",
      fake(upper36, 16),
      fake(base62, 24),
    ];
    for (let n = 0; n < 20_000; n += 1) {
      const text = Array.from(
        { length: 2 + Math.floor(random() * 8) },
        () => pieces[Math.floor(random() * pieces.length)]
      ).join("");
      if (!earlierGateRefuses(text)) continue;
      expect(looksSecret(text), JSON.stringify(text)).toBe(true);
      const note = `Note about the router setup: ${text}`;
      if (!earlierGateRefusesNote(note)) continue;
      for (const byUser of [false, true])
        expect(check(note, byUser), JSON.stringify(note)).toMatch(
          /password, key or code/
        );
    }
  });

  it("refuses an earlier-refused note however it is split across the parts", () => {
    const notes = CREDENTIALS.map(
      ([, text]) => `Work setup for the Acme billing project: ${text}`
    ).filter(earlierGateRefuses);
    for (const text of notes)
      for (let n = 0; n < 6; n += 1) {
        const words = text.split(" ");
        const a = Math.floor(random() * words.length);
        const b = a + 1 + Math.floor(random() * (words.length - a));
        const parts = {
          description: words.slice(0, a).join(" "),
          body: words.slice(a, b).join(" "),
          keywords: words.slice(b).join(" "),
        };
        expect(checkParts(parts), JSON.stringify(parts)).toMatch(
          /password, key or code/
        );
      }
  });

  it("refuses every random key the earlier gate refused, and stores none more often", () => {
    for (const [name, alphabet] of Object.entries(ALPHABETS))
      for (const length of [24, 32, 40, 64]) {
        let earlier = 0;
        let now = 0;
        for (let n = 0; n < 200; n += 1) {
          const text = `Notes for the deploy: value ${fake(alphabet, length)} goes in config.`;
          const refused = earlierGateRefusesNote(text);
          const stored = typeof check(text) !== "string";
          if (refused) expect(stored, `${name} ${text}`).toBe(false);
          if (!refused) earlier += 1;
          if (stored) now += 1;
        }
        expect(now, `${name} ${length}`).toBeLessThanOrEqual(earlier);
      }
  });

  it("reads 100,000 characters of any shape in linear time", () => {
    const size = 100_000;
    const shapes = [
      "password is a ".repeat(size / 14),
      "token: x ".repeat(size / 9),
      `password${" ".repeat(size)}x`,
      ("a".repeat(31) + "1 ").repeat(size / 33),
      "aB1".repeat(size / 3),
      `https://${"/a".repeat(size / 2)}`,
      pem("BEGIN", "RSA").repeat(size / 31),
      "a-".repeat(size / 2),
      "eyJ-".repeat(size / 4),
      "aB1/".repeat(size / 4),
      "word-".repeat(size / 5),
      "-".repeat(size),
      " ".repeat(size),
    ];
    for (const text of shapes) {
      const started = performance.now();
      looksSecret(text);
      expect(performance.now() - started, text.slice(0, 20)).toBeLessThan(
        1_000
      );
    }
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
