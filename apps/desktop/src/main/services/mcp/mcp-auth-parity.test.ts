/**
 * Pins the shared shape of `mcp-auth.json` to the agent's copy.
 *
 * The desktop writes this file after a sign-in; the agent reads it headlessly
 * at connect time and refreshes tokens in it. Neither package can import the
 * other, so both declare the shape themselves, and a field added on one side
 * only is silent. Nothing throws; the token just does not survive the trip, and
 * the server reports as needing sign-in again.
 *
 * The declarations are compared rather than the whole files: the two modules do
 * genuinely different jobs around this one shared format.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const HERE = import.meta.dirname;
const REPO_ROOT = resolve(HERE, "../../../../../..");

const DESKTOP_SOURCE = readFileSync(
  resolve(HERE, "mcp-oauth-service.ts"),
  "utf8"
);
const AGENT_SOURCE = readFileSync(
  resolve(REPO_ROOT, "packages/agent/src/mcp/auth.ts"),
  "utf8"
);

/**
 * The field names of one interface, with `?` kept: optionality is part of the
 * contract. Comments and nested object literals are flattened away, so only the
 * top-level members of the block are reported.
 */
const fieldsOf = (source: string, name: string): string[] => {
  const match = new RegExp(
    `interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`,
    "m"
  ).exec(source);

  if (match == null) throw new Error(`no interface ${name} found`);

  return [...match[1]!.matchAll(/^\s{2}(\w+)(\??):/gm)]
    .map(([, field, optional]) => `${field}${optional}`)
    .sort();
};

describe("the shared mcp-auth.json shape stays in step", () => {
  for (const name of ["McpTokenRecord", "McpAuthFile"]) {
    it(`${name} declares the same fields on both sides`, () => {
      expect(fieldsOf(DESKTOP_SOURCE, name)).toEqual(
        fieldsOf(AGENT_SOURCE, name)
      );
    });
  }

  it("both halves point at the same filename", () => {
    const filename = /"(mcp-auth\.json)"/;

    expect(filename.test(DESKTOP_SOURCE)).toBe(true);
    expect(filename.test(AGENT_SOURCE)).toBe(true);
  });
});
