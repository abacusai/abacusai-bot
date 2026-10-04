import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "abacus-host-bundle-"));
try {
  execFileSync("tar", ["-xzf", resolve(process.argv[2]), "-C", directory]);
  const host = join(directory, "host");
  execFileSync(join(host, "node"), [join(host, "host/index.js"), "--verify"], {
    env: { ...process.env, ABACUSAI_BOT_RESOURCES: join(host, "resources") },
    stdio: "inherit",
  });
  execFileSync(
    join(host, "node"),
    [join(import.meta.dirname, "smoke-host.mjs"), host],
    { stdio: "inherit", timeout: 90_000 }
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
