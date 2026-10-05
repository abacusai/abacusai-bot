import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { visibleNotes } from "./release-notes.mjs";
test("notes include only visible retirements and deferrals", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cutover-notes-"));
  const file = path.join(directory, "rows.ts");
  try {
    fs.writeFileSync(
      file,
      `export const rows=[{id:'A',status:'retired',reason:'Removed.',visible:true},{id:'B',status:'deferred',reason:'Later.',visible:true},{id:'C',status:'green',visible:true},{id:'D',status:'retired',visible:false}]`
    );
    assert.deepEqual(visibleNotes([file]), [
      "- Removed.",
      "- Later. Not in this version.",
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
