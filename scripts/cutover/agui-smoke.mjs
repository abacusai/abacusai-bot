import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
  const root = path.resolve(import.meta.dirname, "../..");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agui-smoke-"));
  try {
    const output = path.join(tmp, "results.json");
    const result = spawnSync(
      "pnpm",
      [
        "--pm-on-fail=ignore",
        "exec",
        "vitest",
        "run",
        "--project",
        "e2e",
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
