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
      "src/main",
      "src/shared",
      "src/preload",
      "src/renderer",
      "scripts/lib",
    ].map(
      (area) =>
        `apps/desktop/${area}/__cutover_knip_canary/unused.${area.startsWith("scripts") ? "mjs" : "ts"}`
    );
    const configFile = "cutover-knip-canaries.json";
    try {
      const config = JSON.parse(fs.readFileSync("knip.json", "utf8"));
      const workspace = config.workspaces["apps/desktop"];
      // Check the production project globs without test readers and entry scripts
      // that inspect all source files. Production mode excludes these untagged globs.
      workspace.entry = [];
      workspace.node = false;
      workspace.vitest = false;
      workspace.vite = false;
      workspace.typescript = false;
      workspace.oxlint = false;
      workspace.oxfmt = false;
      config.workspaces["."] = {
        entry: [],
        project: [],
        node: false,
        vitest: false,
        typescript: false,
        vite: false,
        "github-actions": false,
        pnpm: false,
        turbo: false,
        oxlint: false,
        oxfmt: false,
      };
      fs.writeFileSync(configFile, JSON.stringify(config));
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
          configFile,
          "--workspace",
          "apps/desktop",
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
      fs.rmSync(configFile, { force: true });
      for (const file of files)
        fs.rmSync(path.dirname(file), { force: true, recursive: true });
    }
  }
);
