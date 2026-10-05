import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const app = join(import.meta.dirname, "..");
execFileSync("pnpm", ["bundle"], { cwd: app, stdio: "inherit" });
const stage = await mkdtemp(join(app, "dist", ".dev-"));
try {
  execFileSync("tar", [
    "-xzf",
    join(app, "dist", `host-linux-${process.arch}.tar.gz`),
    "-C",
    stage,
  ]);
  const child = spawn(
    join(stage, "host/bin/abacusai-bot-host"),
    process.argv.slice(2),
    { stdio: "inherit" }
  );
  const stop = () => child.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await rm(stage, { recursive: true, force: true });
}
