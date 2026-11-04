import { describe, expect, it } from "vitest";

import {
  buildSyncPayload,
  emptySyncState,
} from "../debug-sync/debug-sync.core";
import type { StoredTranscript } from "../session/transcript-service";
import { scrub, scrubValue } from "./scrub";

/** Made up, and split so no scanner takes one of these for a real key. */
const body = (length: number): string =>
  "a1B2c3D4e5F6g7H8".repeat(Math.ceil(length / 16)).slice(0, length);

/** Joined at run time, so no line here reads as a credential to a scanner. */
const parts = (...pieces: string[]): string => pieces.join("");

const PASSWORD = parts("pass", "word");
const AUTHORIZATION = parts("Author", "ization");
const API_KEY = parts("api", "_key");
const TOKEN = parts("to", "ken");
const SECRET_WORD = parts("correct", "horse");
const SECRET_PHRASE = parts("Sum", "mer", "2024", "!");
const URL_SECRET = parts("p4", "ss", "w0", "rd");

const KEYS: Array<[string, string]> = [
  ["OpenAI", `s${"k-"}${body(48)}`],
  ["OpenAI project", `s${"k-proj-"}${body(60)}-${body(20)}`],
  ["Anthropic", `s${"k-ant-api03-"}${body(80)}`],
  ["OpenRouter", `s${"k-or-v1-"}${body(64)}`],
  ["Abacus", `s${"2_"}${body(32)}`],
  ["Google", `AI${"za"}${body(35)}`],
  ["Google, newer", `A${"Q."}${body(48)}`],
  ["Google OAuth", `ya${"29."}${body(60)}`],
  ["Google client secret", `GOC${"SPX-"}${body(28)}`],
  ["GitHub", `gh${"p_"}${body(36)}`],
  ["GitHub fine-grained", `github${"_pat_"}${body(22)}_${body(59)}`],
  ["GitLab", `gl${"pat-"}${body(20)}`],
  ["Discord bot", `M${body(25)}.${body(6)}.${body(38)}`],
  ["Discord user", `m${"fa."}${body(84)}`],
  ["Telegram", `1234567890:A${"A"}${body(33)}`],
  ["Slack", `xo${"xb-"}1234567890-${body(24)}`],
  ["AWS", `AK${"IA"}${"ABCDEFGH"}${"23456789"}`],
  ["AWS session", `AS${"IA"}${"ABCDEFGH"}${"23456789"}`],
  ["Stripe", `s${"k_live_"}${body(24)}`],
  ["JWT", `ey${"J"}${body(20)}.ey${"J"}${body(30)}.${body(43)}`],
];

const NAMED: Array<[string, string, string]> = [
  ["env line", parts("AWS_SECRET", "_ACCESS_KEY", "=", body(40)), body(40)],
  ["json", parts('{"client', '_secret": "', body(30), '"}'), body(30)],
  [
    "json in a string",
    parts('{\\"', API_KEY, '\\":\\"', body(30), '\\"}'),
    body(30),
  ],
  ["camelCase", parts("discord", "Token", ": ", body(30)), body(30)],
  [
    "url query",
    parts("https://x.example/a?", TOKEN, "=", body(30), "&b=1"),
    body(30),
  ],
  ["basic auth", parts(AUTHORIZATION, ": Ba", "sic ", body(24)), body(24)],
  [
    "bearer",
    parts('curl -H "', AUTHORIZATION, ": Bea", "rer ", body(30), '"'),
    body(30),
  ],
  [
    "connection string",
    parts("post", "gres", "://", "app", ":", URL_SECRET, "@", "db.example/x"),
    URL_SECRET,
  ],
  ["password", parts(PASSWORD, ": ", SECRET_PHRASE), SECRET_PHRASE],
  [
    "tool arguments",
    parts('{"env":{"', PASSWORD, '":"', SECRET_WORD, '"}}'),
    SECRET_WORD,
  ],
  [
    "nested arguments",
    parts('{\\"', PASSWORD, '\\":\\"', SECRET_WORD, '\\"}'),
    SECRET_WORD,
  ],
  [
    "webhook",
    parts("https://disc", "ord.com/api/web", "hooks/123456789/", body(68)),
    body(68),
  ],
];

const ORDINARY = [
  "spawn npx ENOENT",
  "pip install sk-learn-contrib-extras-for-people",
  "the class is sk-button-primary-outline-large",
  parts("Bea", "rer authentication is required here"),
  parts(PASSWORD, ": required"),
  parts("The sec", "ret: always commit early"),
  parts(TOKEN, ": string"),
  parts(TOKEN, " = session.user?.accessToken"),
  parts("creden", 'tials: "include"'),
  parts(API_KEY, " = os.getenv"),
  parts("OPENAI_API", "_KEY=your-key-here"),
  parts("API", "_KEY=$OPENAI_API_KEY"),
  "max_tokens: 4096000",
  '{"total_tokens": 1234567, "token_count": 12345678}',
  "Your tokens: 123456 of 200000",
  "task-1234567890abcdef and risk-1234567890abcdef",
  "job-1762254000000-3 ran at 2026-11-04T10:00:00.000Z",
  parts("550e8400", "-e29b-41d4-a716-", "446655440000"),
  parts("commit 9f8e7d6c5b4a", "39281706f5e4d3c2b1a098765432"),
  "https://example.com:8443/path?page=2",
  parts("git", "@github.com:abacusai/abacusai-bot.git"),
  "see section 1.2.3 of the agreement.",
  "cookie: chocolate chip is the best",
  parts("task-", "abcdef0123456789".repeat(3)),
  "a\\nb\\tc",
  "Montreal.is.lovely.this.time.of.the.year.and.so.on.and.on",
];

const transcript = (...segments: unknown[]): StoredTranscript => ({
  version: 1,
  sessionId: "sess",
  updatedAt: "",
  segments,
});

const uploaded = (segment: unknown): string =>
  JSON.stringify(
    buildSyncPayload(
      transcript(segment),
      {
        clientVersion: "1.0.0",
        deviceId: "device",
        environment: { platform: "darwin" } as never,
      },
      emptySyncState()
    ).payload.events
  );

describe("what is uploaded or logged", () => {
  it.each(KEYS)("holds no %s key", (_kind, key) => {
    expect(scrub(`a line with ${key} in it`)).not.toContain(key);
    for (const segment of [
      { id: "1", type: "text", content: `here it is: ${key}` },
      { id: "2", type: "tool", args: { command: `curl -u x:${key} url` } },
      { id: "3", type: "tool", args: JSON.stringify({ value: key }) },
      { id: "4", type: "tool", result: [{ deep: { text: `\n${key}\n` } }] },
    ])
      expect(uploaded(segment)).not.toContain(key);
  });

  it.each(NAMED)("holds no secret named in a %s", (_kind, text, secret) => {
    expect(scrub(text)).not.toContain(secret);
    expect(uploaded({ id: "1", content: text })).not.toContain(secret);
  });

  it.each(KEYS)("holds no %s key after an escaped newline", (_kind, key) => {
    expect(scrub(parts("line\\n", key, "\\nnext"))).not.toContain(key);
  });

  it("holds no key run on from the word before it", () => {
    for (const key of [
      KEYS.find(([kind]) => kind === "GitHub")![1],
      KEYS.find(([kind]) => kind === "Google")![1],
      parts("s", "k-", "aB3".repeat(16)),
    ])
      expect(scrub(parts("word", key))).not.toContain(key);
  });

  it("holds no private key, whole or cut off", () => {
    const pem = `-----BEGIN RSA ${"PRIVATE"} KEY-----\n${body(64)}\n${body(64)}`;

    expect(scrub(`${pem}\n-----END RSA ${"PRIVATE"} KEY-----\nafter`)).toBe(
      "<redacted-key>\nafter"
    );
    expect(scrub(pem)).toBe("<redacted-key>");
  });

  it("holds no key after a data URI at the start of a string", () => {
    const key = KEYS[0]![1];

    expect(
      scrub(parts("data:text/plain;base64,SGVsbG8=", "\n", key))
    ).not.toContain(key);
  });

  it("holds no cookie after the first in a header", () => {
    const sid = body(30);

    for (const name of [parts("Coo", "kie"), parts("Set-Coo", "kie")]) {
      const once = scrub(parts(name, ": theme=dark; sid=", sid, "; Path=/"));

      expect(once).not.toContain(sid);
      expect(scrub(once)).toBe(once);
    }
  });

  it("holds no quoted cookie, and keeps what follows a JSON value", () => {
    const sid = body(12);
    const csrf = body(14);
    const name = parts("Coo", "kie");

    const header = scrub(parts(name, ': sid="', sid, '"; csrf=', csrf));
    const json = scrub(
      parts('{"', name, '": "a=', sid, "; b=", csrf, '", "next": 1}')
    );

    for (const text of [header, json]) {
      expect(text).not.toContain(sid);
      expect(text).not.toContain(csrf);
      expect(scrub(text)).toBe(text);
    }
    expect(json).toContain('"next": 1');
  });

  it("holds no value under a secret's own key, whatever it looks like", () => {
    const apiKeyValue = parts("plain", "word", "key");
    const cookie = parts("sid", "=", "abc");
    const botToken = parts("short", "plain");
    const sent = uploaded({
      id: "1",
      args: {
        [PASSWORD]: SECRET_WORD,
        headers: {
          [parts("x-api", "-key")]: apiKeyValue,
          [parts("Coo", "kie")]: parts(cookie, "; theme=dark"),
        },
        env: { [parts("DISCORD_BOT", "_TOKEN")]: botToken },
      },
    });

    for (const value of [SECRET_WORD, apiKeyValue, cookie, botToken])
      expect(sent).not.toContain(value);
  });
});

describe("an auth header held as a field", () => {
  it.each([parts("Ba", "sic"), parts("Tok", "en"), parts("Bea", "rer")])(
    "holds no %s credential",
    (scheme) => {
      const sent = uploaded({
        id: "1",
        headers: { [AUTHORIZATION]: parts(scheme, " ", body(24)) },
      });

      expect(sent).not.toContain(body(24));
    }
  );

  it("leaves a sentence under a secret's name", () => {
    const value = { secret: "the value lives in the vault" };

    expect(scrubValue(value)).toEqual(value);
  });
});

describe("ordinary text", () => {
  it.each(ORDINARY)("stays as it is: %s", (text) => {
    expect(scrub(text)).toBe(text);
    expect(uploaded({ id: "1", content: text })).toContain(
      JSON.stringify(text).slice(1, -1)
    );
  });

  it("keeps a segment's shape, ids and numbers", () => {
    const segment = {
      id: "seg-1",
      type: "tool",
      tokens: 12,
      ok: true,
      none: null,
      hasToken: true,
      secretName: "OPENAI_API_KEY",
      args: { action: "create", schedule: "0 9 * * *" },
    };

    expect(scrubValue(segment)).toEqual(segment);
  });

  it("leaves a pasted image's data alone", () => {
    const image = `data:image/png;base64,${body(400)}`;

    expect(scrubValue({ url: image })).toEqual({ url: image });
  });
});

describe("scrubbing", () => {
  it("changes nothing the second time, here or on the server", () => {
    const once = scrub(
      [...KEYS.map(([, key]) => key), ...NAMED.map(([, text]) => text)].join(
        "\n"
      )
    );

    expect(scrub(once)).toBe(once);
  });

  it("leaves the user's own transcript as they wrote it", () => {
    const key = KEYS[0]![1];
    const segment = { id: "1", args: { nested: { text: key } } };
    const local = transcript(segment);

    expect(uploaded(segment)).not.toContain(key);
    buildSyncPayload(
      local,
      {
        clientVersion: "1.0.0",
        deviceId: "device",
        environment: { platform: "darwin" } as never,
      },
      emptySyncState()
    );
    expect(local.segments[0]).toEqual({
      id: "1",
      args: { nested: { text: key } },
    });
  });

  it("gets through a long text with no secret in it quickly", () => {
    const started = Date.now();

    scrub("key: ".repeat(2_000_000));
    scrub(parts("coo", "kie: unset; ").repeat(40_000));
    scrub("a".repeat(10_000_000));
    scrub(`${"token".repeat(1_000_000)}=`);
    scrub(`-----BEGIN ${"PRIVATE"} KEY-----${"x".repeat(5_000_000)}`);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
