import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

test("Codex r1 report keeps release acceptance closed independently of local fix gates", () => {
  const report = fs.readFileSync(
    new URL("../../docs/rewrite/reports/07-cutover.md", import.meta.url),
    "utf8"
  );
  const fixes = report.split("## Codex r1 fixes")[1];
  assert.ok(fixes, "missing Codex r1 fixes section");
  assert.match(fixes, /Release N is not ready to ship\./);
  assert.match(fixes, /Release acceptance \| Not green/);
  assert.match(fixes, /M3/);
  assert.match(fixes, /signed RC/);
  assert.match(fixes, /Windows/);
  assert.match(fixes, /Linux/);
  for (let finding = 2; finding <= 11; finding++)
    assert.match(fixes, new RegExp(`\\| ${finding} \\| [a-f0-9]{8} \\|`));
});
