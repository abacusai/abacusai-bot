import { describe, expect, it } from "vitest";

import { hasKey, scrubKeys } from "./scrub";

// Built at run time, so no scanner reads these as real keys.
const body = (length: number) => "aB3dE6gH9k".repeat(8).slice(0, length);
const hex = (length: number) => "0a1b2c3d4e5f".repeat(8).slice(0, length);
const pem = (kind: string) =>
  [
    `${"-".repeat(5)}BEGIN ${kind}PRIVATE KEY${"-".repeat(5)}`,
    body(64),
    `${"-".repeat(5)}END ${kind}PRIVATE KEY${"-".repeat(5)}`,
  ].join("\n");

const REAL_KEYS: [string, string][] = [
  ["an OpenAI key", `const key = "${["sk", "proj", body(40)].join("-")}";`],
  ["an Anthropic key", `key: '${["sk", "ant", "api03", body(40)].join("-")}'`],
  ["a GitHub token", ["ghp", body(36)].join("_")],
  ["a fine-grained GitHub token", ["github", "pat", body(40)].join("_")],
  ["a GitLab token", ["glpat", body(20)].join("-")],
  ["an AWS key id", `id = ${["AKIA", "ABCD1234EFGH5678"].join("")}`],
  ["a Google key", `src="maps?key=${["AIza", body(35)].join("")}"`],
  ["a Slack token", ["xoxb", "12345678", body(24)].join("-")],
  ["a Stripe key", `Stripe(${["sk", "live", body(24)].join("_")})`],
  ["a Groq key", ["gsk", body(40)].join("_")],
  ["a Hugging Face token", ["hf", body(34)].join("_")],
  ["an xAI key", ["xai", body(48)].join("-")],
  ["a Telegram bot token", ["123456789", `AA${body(33)}`].join(":")],
  ["a signed token", ["eyJ", "eyJ", ""].map((p) => p + body(20)).join(".")],
  ["a literal bearer", `Authorization: Bearer ${body(32)}`],
  ["an RSA private key", pem("RSA ")],
  ["a bare private key", pem("")],
  ["an env line", `STRIPE_${"SECRET"}_KEY=${hex(24)}`],
  ["a short env value", `X_${"SECRET"}_KEY=value`],
  ["an exported env line", `export DB_${"PASSWORD"}=hunter2`],
  ["a quoted env line", `GH_${"TOKEN"}="${hex(24)}"`],
  ["a compose env line", `  - API_${"KEY"}=${hex(24)}`],
  ["a Dockerfile env line", `ENV AUTH_${"TOKEN"}=${hex(24)}`],
  ["a literal in code", `const apiKey = "${hex(24)}";`],
  ["a literal password", `password: "${["hunter", "2024"].join("")}"`],
  ["a JSON value", `{ "client_secret": "${hex(24)}" }`],
  ["a YAML value", `api_key: ${hex(24)}`],
];

const ORDINARY_SOURCE: [string, string][] = [
  ["a schema field", "password: z.string(),"],
  ["a schema field with rules", "password: z.string().min(8),"],
  ["a form read", 'const password = form.get("password");'],
  ["a bearer template", "headers: { Authorization: `Bearer ${token}` },"],
  ["a bearer concatenation", 'authorization: "Bearer " + token,'],
  ["an env read", "const apiKey = process.env.API_KEY;"],
  ["an env read by name", 'API_KEY = os.environ["API_KEY"]'],
  ["a python call", "SECRET_KEY=get_secret()"],
  ["a type", "password: string;"],
  ["an input", '<input type="password" name="password" />'],
  ["a shorthand property", "password: password"],
  ["a member read", "token: response.data.accessToken"],
  ["a label", '"password": "Contraseña"'],
  ["a sentence", 'secret: "Keep this between us"'],
  ["a template value", 'apiKey: "${KEY}1234"'],
  ["a placeholder", 'apiKey: "your-api-key-here1"'],
  ["a placeholder env line", "API_KEY=your_api_key_here"],
  ["an empty env line", "API_KEY="],
  ["a shell reference", "ENV API_KEY=$API_KEY"],
  ["a public key", "NEXT_PUBLIC_KEY=abc123"],
  ["a boolean", "ENABLE_TOKEN=true"],
  ["a path", "PWD=/home/me/site"],
  ["a CSS class", '<div class="sk-folding-cube-animation"></div>'],
  ["a word with the prefix", "risk-assessment-for-the-bakery-site"],
  ["a certificate", "BEGIN CERTIFICATE"],
];

describe("hasKey", () => {
  it.each(REAL_KEYS)("finds %s", (_name, text) => {
    expect(hasKey(text)).toBe(true);
  });

  it.each(ORDINARY_SOURCE)("leaves %s alone", (_name, text) => {
    expect(hasKey(text)).toBe(false);
  });
});

describe("scrubKeys", () => {
  it.each(REAL_KEYS)("takes %s out", (_name, text) => {
    const scrubbed = scrubKeys(text);
    expect(scrubbed).not.toBe(text);
    expect(hasKey(scrubbed)).toBe(false);
  });

  it("keeps the words around a key", () => {
    expect(scrubKeys(`Use X_${"SECRET"}_KEY=value here`)).toContain("Use ");
    expect(scrubKeys(`before\n${pem("")}\nafter`)).toBe(
      "before\n<redacted-key>\nafter"
    );
  });
});
