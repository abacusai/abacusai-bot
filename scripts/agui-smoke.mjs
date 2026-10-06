import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const requireExecutedTests = (report) => {
  if (!(report.numPassedTests > 0))
    throw new Error("AG-UI smoke executed no passing tests");
  if (report.numFailedTests > 0) throw new Error("AG-UI smoke failed");
  if (report.numPendingTests > 0) throw new Error("AG-UI smoke skipped tests");
};
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(import.meta.dirname, "..");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agui-smoke-"));
  try {
    const output = path.join(tmp, "results.json");
    const vitest = path.join(
      path.dirname(
        createRequire(import.meta.url).resolve("vitest/package.json")
      ),
      "vitest.mjs"
    );
    // Launch JavaScript directly: Windows cannot spawn an extensionless .cmd shim.
    const result = spawnSync(
      process.execPath,
      [
        vitest,
        "run",
        "--project",
        "e2e",
        "--maxWorkers=2",
        "src/agui/agui-spawn.e2e.test.ts",
        "--reporter=json",
        `--outputFile=${output}`,
      ],
      { cwd: path.join(root, "packages/agent"), stdio: "inherit" }
    );
    if (result.error || result.status !== 0)
      throw result.error ?? new Error(`AG-UI smoke exited ${result.status}`);
    requireExecutedTests(JSON.parse(fs.readFileSync(output, "utf8")));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
