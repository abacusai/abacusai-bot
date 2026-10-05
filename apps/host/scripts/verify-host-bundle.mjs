import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  rm,
  readdir,
  lstat,
  realpath,
  readlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "abacus-host-bundle-"));
try {
  execFileSync("tar", ["-xzf", resolve(process.argv[2]), "-C", directory]);
  const host = join(directory, "host");
  const audit = async (dir) => {
    for (const name of await readdir(dir)) {
      const file = join(dir, name);
      const stat = await lstat(file);
      if (stat.isSymbolicLink()) {
        const target = await realpath(file);
        const rel = relative(host, target);
        if (
          isAbsolute(await readlink(file)) ||
          rel.startsWith("..") ||
          isAbsolute(rel)
        )
          throw new Error(`Escaping symlink: ${file}`);
      } else if (stat.isDirectory()) await audit(file);
    }
  };
  await audit(host);
  const env = { ...process.env };
  delete env.ABACUSAI_BOT_RESOURCES;
  execFileSync(join(host, "node"), [join(host, "host/index.js"), "--verify"], {
    env,
    cwd: directory,
    stdio: ["ignore", "ignore", "inherit"],
  });
  execFileSync(
    join(host, "node"),
    [join(import.meta.dirname, "smoke-host.mjs"), host],
    { stdio: "inherit", timeout: 90_000 }
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
