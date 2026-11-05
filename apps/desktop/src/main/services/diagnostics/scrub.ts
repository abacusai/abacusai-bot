/**
 * Take the secrets and the user's name out of anything on its way to disk.
 * Omission cannot cover a key that reached a console.error or a home
 * directory in every path; this runs over whole texts so a new stream is
 * covered by default. Shared by log-dump.ts and log-store.ts.
 */
import os from "node:os";
import path from "node:path";

/** Keys by their issuer's own shape: a match is a key wherever it sits. */
const KEY_SHAPES: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  // sk-…, rk-…, xai-…: a digit tells a key from a hyphenated name (sk-folding-cube).
  /\b(?:sk|rk|xai|pplx)-(?=[A-Za-z0-9_-]{0,200}\d)[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\b(?:glpat|nvapi|GOCSPX)-[A-Za-z0-9_-]{20,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bwhsec_[A-Za-z0-9]{20,}/g,
  /\b(?:hf|gsk|npm|r8|dop_v1|s2|shp(?:at|ss|ca|pa))_[A-Za-z0-9]{20,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // A bearer spelled out; `Bearer ${token}` has none of these characters.
  /\b[Bb]earer\s+(?=[A-Za-z0-9._~+/-]{0,200}\d)[A-Za-z0-9._~+/-]{20,}=*/g,
];

const KEY_WORDS =
  "(?:api|secret|access|private|signing|encryption)[_-]?key|(?:auth|access|refresh)[_-]?token|client[_-]?secret|secret|token|password|passwd";

/** A value that stands in for a key: a template, a reference, a placeholder. */
const NOT_A_VALUE =
  /^(?:<.*>|true|false|null|none|undefined|[/~.].*|x{4,}|\*{4,})$|\$\{|\{\{|your|example|placeholder|change[-_]?me|replace|dummy|sample|redacted|test/i;

const isValue = (value: string): boolean => !NOT_A_VALUE.test(value);

/** In source a word may be a label: a value there has a digit or a key's length. */
const isSourceValue = (value: string): boolean =>
  isValue(value) && (/\d/.test(value) || value.length >= 20);

/** A key named and given a literal value; a read of one (`form.get(…)`) never matches. */
const KEY_ASSIGNMENTS: readonly {
  pattern: RegExp;
  literal: (value: string) => boolean;
}[] = [
  // Env lines: X_SECRET_KEY=…, export, compose and Dockerfile forms.
  {
    pattern:
      /^[ \t]*(?:(?:export|ENV|ARG|-)[ \t]+)?(?![A-Z0-9_]*PUBLI)[A-Z0-9_]*(?:(?:API|SECRET|ACCESS|PRIVATE|AUTH|SIGNING|ENCRYPTION)_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD)=(?<quote>["']?)(?<value>[^\s"'#$(){}[\];,<>]{4,})\k<quote>[ \t]*(?:#.*)?$/gm,
    literal: isValue,
  },
  // Code and JSON: a quoted string after the name.
  {
    pattern: new RegExp(
      `(?:${KEY_WORDS})["'\`]?\\s*(?:=>|:=|[:=])\\s*(?<quote>["'\`])(?<value>[^"'\`\\s]{8,})\\k<quote>`,
      "gi"
    ),
    literal: isSourceValue,
  },
  // YAML: a bare value alone on its line.
  {
    pattern: new RegExp(
      `^[ \\t-]*["']?[\\w-]*(?:${KEY_WORDS})["']?[ \\t]*:[ \\t]*(?<value>[A-Za-z0-9+/=_~@%!-]{8,})[ \\t]*$`,
      "gim"
    ),
    literal: (value) => isValue(value) && /\d/.test(value),
  },
];

/** A real key in `text`: a key shape or a literal value, never code that only names one. */
export function hasKey(text: string): boolean {
  return (
    KEY_SHAPES.some((shape) => text.search(shape) >= 0) ||
    KEY_ASSIGNMENTS.some(({ pattern, literal }) =>
      [...text.matchAll(pattern)].some((found) =>
        literal(found.groups?.value ?? "")
      )
    )
  );
}

/** Key shapes and named secrets, redacted. */
export function scrubKeys(text: string): string {
  let out = text
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, "$1<redacted>")
    .replace(/\b(sk|rk)-[A-Za-z0-9_-]{8,}/g, "<redacted-key>");

  for (const shape of KEY_SHAPES) out = out.replace(shape, "<redacted-key>");

  // Anything that names itself: api_key=…, "token": "…".
  out = out.replace(
    /((?:api[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password|authorization)["'\s]*[:=]["'\s]*)([^\s"',}]{6,})/gi,
    "$1<redacted>"
  );

  for (const { pattern, literal } of KEY_ASSIGNMENTS)
    out = out.replace(pattern, (match: string, ...rest: unknown[]) => {
      const { value } = rest.at(-1) as { value: string };
      return literal(value) ? match.replace(value, "<redacted>") : match;
    });

  return out;
}

/** Scrub one text: key shapes, named secrets, and the user's own name. */
export function scrub(text: string, homeDir?: string): string {
  let out = scrubKeys(text);

  // The user's name is the parent of `~/.abacusai-bot`; the OS's answer is
  // read too, because either can be the one that appears in the paths.
  const candidates = new Set<string>();

  for (const name of [
    homeDir != null ? path.basename(path.dirname(homeDir)) : "",
    safely(() => path.basename(os.homedir())),
    safely(() => os.userInfo().username),
  ]) {
    if (name.length > 2 && name !== "unknown") candidates.add(name);
  }

  for (const name of candidates) out = out.split(name).join("<user>");

  return out;
}

function safely(read: () => string): string {
  try {
    return read();
  } catch {
    return "unknown";
  }
}
