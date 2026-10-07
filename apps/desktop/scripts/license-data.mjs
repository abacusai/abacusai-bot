import { createHash } from "node:crypto";

export const allowedLicenses = new Set([
  "MIT",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Apache-2.0",
  "0BSD",
  "CC0-1.0",
  "BlueOak-1.0.0",
  "Python-2.0",
  "MPL-2.0",
  "OFL-1.1",
  "Unlicense",
  "CC-BY-4.0",
  "CC-BY-3.0",
  "Zlib",
  "BSL-1.0",
]);

// MPL is file-level copyleft: retain notices and distribute modified covered
// files under MPL. This allowlist is a build policy, not legal advice.
// Parse the SPDX AND/OR grammar with precedence. Unknown identifiers and WITH
// exceptions require a pinned review instead of accidentally accepting a branch.
export function acceptableExpression(expression) {
  if (typeof expression !== "string") return false;
  const tokens = expression.match(/[()]|[^\s()]+/g) ?? [];
  let index = 0;
  function term() {
    if (tokens[index] === "(") {
      index++;
      const value = or();
      if (tokens[index++] !== ")") throw new Error("Malformed SPDX");
      return value;
    }
    const id = tokens[index++];
    if (!id || ["AND", "OR", ")", "WITH"].includes(id))
      throw new Error("Malformed SPDX");
    return allowedLicenses.has(id);
  }
  function and() {
    let value = term();
    while (tokens[index] === "AND") {
      index++;
      const right = term();
      value = value && right;
    }
    return value;
  }
  function or() {
    let value = and();
    while (tokens[index] === "OR") {
      index++;
      const right = and();
      value = value || right;
    }
    return value;
  }
  try {
    const value = or();
    return index === tokens.length && value;
  } catch {
    return false;
  }
}

export function policyFailures(entries, reviews = {}) {
  return entries.flatMap((entry) => {
    const expression = entry.license;
    const accepted = acceptableExpression(expression);
    const review = reviews[`${entry.name}@${entry.version}`];
    return accepted ||
      (review?.license === expression && review.reason && review.source)
      ? []
      : [`${entry.name}@${entry.version}: ${expression || "UNKNOWN"}`];
  });
}

export function licenseData(entries) {
  const texts = {};
  const seen = new Set();
  const packages = entries
    .map(({ text, ...entry }) => {
      if (!text?.trim())
        throw new Error(`Missing license text: ${entry.name}@${entry.version}`);
      const textHash = createHash("sha256").update(text).digest("hex");
      texts[textHash] = text;
      return { ...entry, textHash };
    })
    .filter((entry) => {
      const key = JSON.stringify([
        entry.name,
        entry.version,
        entry.license,
        entry.url,
        entry.textHash,
        entry.review,
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) =>
      `${a.license}:${a.name}:${a.version}`.localeCompare(
        `${b.license}:${b.name}:${b.version}`,
        "en"
      )
    );
  return {
    packages,
    texts: Object.fromEntries(
      Object.entries(texts).sort(([a], [b]) => a.localeCompare(b, "en"))
    ),
  };
}

export function repositoryUrl(repository, homepage) {
  let value = typeof repository === "string" ? repository : repository?.url;
  value = value
    ?.replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "");
  return /^https?:\/\//i.test(value ?? "")
    ? value
    : /^https?:\/\//i.test(homepage ?? "")
      ? homepage
      : undefined;
}
