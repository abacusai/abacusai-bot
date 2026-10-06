#!/usr/bin/env node
/**
 * Copies the agent's golden AG-UI streams
 * (packages/agent/src/agui/__fixtures__/*.agui.jsonl) into the chat kit's
 * fixtures (src/features/chat/fixtures/scenarios/), one
 * `{"seq":n,"event":{…}}` line per source line, seqs from 1 (spec 02 §11.1).
 * R2-T29 fails when a copy differs from its source.
 *
 *   node scripts/sync-chat-fixtures.mjs [--check]
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const web = join(import.meta.dirname, "..");
const source = join(web, "../../packages/agent/src/agui/__fixtures__");
const target = join(web, "src/features/chat/fixtures/scenarios");
const check = process.argv.includes("--check");

export const withSeqs = (text) =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) =>
      JSON.stringify({ seq: index + 1, event: JSON.parse(line) })
    )
    .join("\n") + "\n";

mkdirSync(target, { recursive: true });
let stale = 0;
for (const name of readdirSync(source)
  .filter((file) => file.endsWith(".agui.jsonl"))
  .sort()) {
  const expected = withSeqs(readFileSync(join(source, name), "utf8"));
  const path = join(target, name);
  const current = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (current === expected) continue;
  stale += 1;
  if (check) console.error(`stale: ${name}`);
  else writeFileSync(path, expected);
}
if (check && stale > 0) process.exit(1);
console.log(
  check ? "chat fixtures in sync" : `chat fixtures: ${stale} written`
);
