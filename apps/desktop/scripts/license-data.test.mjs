import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptableExpression,
  licenseData,
  policyFailures,
  repositoryUrl,
} from "./license-data.mjs";

test("deduplicates original texts by SHA-256 and sorts package groups deterministically", () => {
  const input = [
    {
      name: "z",
      version: "2",
      license: "MIT",
      text: "Copyright Alice\nMIT text",
    },
    {
      name: "a",
      version: "1",
      license: "ISC",
      text: "Copyright Alice\nMIT text",
    },
  ];
  const data = licenseData(input);
  assert.equal(Object.keys(data.texts).length, 1);
  assert.equal(data.packages[0].name, "a");
  assert.equal(data.packages[0].textHash, data.packages[1].textHash);
  assert.deepEqual(licenseData(input.toReversed()), data);
  assert.throws(() => licenseData([{ ...input[0], text: " " }]), /z@2/);
});
test("SPDX expressions respect parentheses, alternatives, conjunctions and invalid syntax", () => {
  for (const value of [
    "MIT",
    "(MIT OR GPL-2.0-only)",
    "Apache-2.0 AND MIT",
    "MPL-2.0",
    "OFL-1.1",
  ])
    assert.equal(acceptableExpression(value), true, value);
  for (const value of [
    "GPL-3.0-only",
    "AGPL-3.0-only",
    "LGPL-2.1-only",
    "UNKNOWN",
    "UNLICENSED",
    "",
    "MIT AND",
    "(MIT",
    "MIT OR",
    "MIT WITH unknown-exception",
    "(MIT OR ISC) AND GPL-3.0-only",
  ])
    assert.equal(acceptableExpression(value), false, value);
});
test("exceptions require exact package, version, expression and documented source", () => {
  const entry = { name: "tool", version: "1", license: "GPL-2.0-only" };
  assert.deepEqual(policyFailures([entry]), ["tool@1: GPL-2.0-only"]);
  const reviews = {
    "tool@1": {
      license: entry.license,
      reason: "Separate executable; source obligations",
      source: "https://example.com/source",
    },
  };
  assert.deepEqual(policyFailures([entry], reviews), []);
  assert.equal(policyFailures([{ ...entry, version: "2" }], reviews).length, 1);
  assert.equal(
    policyFailures([{ ...entry, license: "AGPL-3.0-only" }], reviews).length,
    1
  );
  assert.equal(
    policyFailures([entry], { "tool@1": { ...reviews["tool@1"], source: "" } })
      .length,
    1
  );
});
test("repository links normalize npm metadata and reject unsafe protocols", () => {
  assert.equal(
    repositoryUrl({ url: "git+https://github.com/example/pkg.git" }),
    "https://github.com/example/pkg"
  );
  assert.equal(
    repositoryUrl("javascript:alert(1)", "https://example.com"),
    "https://example.com"
  );
  assert.equal(repositoryUrl("file:///etc/passwd"), undefined);
});
