import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
test(
  "R7-T22 knip reports unused files in all five project areas",
  { timeout: 60000 },
  () => {
    const files = [
      "apps/desktop/src/main/__cutover_knip_canary/unused.ts",
      "apps/desktop/src/preload/__cutover_knip_canary/unused.ts",
      "apps/desktop/scripts/lib/__cutover_knip_canary/unused.mjs",
      "apps/web/src/__cutover_knip_canary/unused.ts",
      "packages/contract/src/__cutover_knip_canary/unused.ts",
    ];
    const productionConfig = fs.readFileSync("knip.json", "utf8");
    try {
      for (const file of files) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "export const cutoverCanary = true;\n");
      }
      const result = spawnSync(
        "pnpm",
        [
          "--pm-on-fail=ignore",
          "exec",
          "knip",
          "--config",
          "knip.json",
          "--workspace",
          "apps/desktop",
          "--workspace",
          "apps/web",
          "--workspace",
          "packages/contract",
          "--include",
          "files",
          "--no-gitignore",
          "--reporter",
          "json",
        ],
        { encoding: "utf8", timeout: 55000 }
      );
      assert.equal(result.error, undefined);
      assert.ok(result.stdout.trim(), result.stderr);
      const output = JSON.parse(result.stdout);
      for (const file of files)
        assert.ok(
          JSON.stringify(output).includes(file),
          `${file} absent from knip results`
        );
    } finally {
      assert.equal(fs.readFileSync("knip.json", "utf8"), productionConfig);
      for (const file of files)
        fs.rmSync(path.dirname(file), { force: true, recursive: true });
    }
  }
);
