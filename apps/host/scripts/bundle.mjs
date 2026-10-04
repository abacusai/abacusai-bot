import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
  chmod,
  realpath,
  access,
  rename,
} from "node:fs/promises";
import { resolve, dirname, join, relative } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const app = join(root, "apps/host");
const arch = process.arch;
if (process.platform !== "linux" || !["x64", "arm64"].includes(arch))
  throw new Error("Bundle requires Linux x64 or arm64");
const nodeVersion = "22.22.0";
const checksums = {
  x64: "9aa8e9d2298ab68c600bd6fb86a6c13bce11a4eca1ba9b39d79fa021755d7c37",
  arm64: "1bf1eb9ee63ffc4e5d324c0b9b62cf4a289f44332dfef9607cea1a0d9596ba6f",
};
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
run("pnpm", [
  "exec",
  "turbo",
  "run",
  "build",
  "vendor",
  "--filter=@abacus-ai/agent...",
  "--filter=@abacus-ai/connectors...",
  "--filter=@abacus-ai/updater...",
]);
await mkdir(join(app, "dist"), { recursive: true });
const stage = await mkdtemp(join(app, "dist", ".bundle-"));
const host = join(stage, "host");
await mkdir(join(host, "bin"), { recursive: true });
await mkdir(join(host, "host"), { recursive: true });
run("pnpm", [
  "--filter",
  "@abacus-ai/host",
  "build",
  "--out-dir",
  join(host, "host"),
]);
const manifest = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
await writeFile(
  join(host, "host/package.json"),
  JSON.stringify({
    type: "module",
    version: manifest.version,
    contractVersion: Number(
      (
        await readFile(
          join(root, "packages/contract/src/contract/index.ts"),
          "utf8"
        )
      ).match(/CONTRACT_VERSION = (\d+)/)[1]
    ),
  })
);
const archive = join(stage, "node.tar.xz");
const response = await fetch(
  `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-${arch}.tar.xz`
);
if (!response.ok) throw new Error(`Node download failed: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== checksums[arch])
  throw new Error("Node checksum mismatch");
await writeFile(archive, bytes);
run("tar", [
  "-xJf",
  archive,
  "-C",
  stage,
  "--strip-components=1",
  `node-v${nodeVersion}-linux-${arch}/bin/node`,
]);
await cp(join(stage, "bin/node"), join(host, "node"));
await chmod(join(host, "node"), 0o755);
await writeFile(
  join(host, "bin/abacusai-bot-host"),
  '#!/bin/sh\nDIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexport ABACUSAI_BOT_RESOURCES="$DIR/resources"\nexec "$DIR/node" "$DIR/host/index.js" "$@"\n',
  { mode: 0o755 }
);
await cp(join(root, "apps/desktop/resources"), join(host, "resources"), {
  recursive: true,
  dereference: true,
  filter: (source) =>
    !source.includes("/vendor/llama") && !source.endsWith("/scrcpy-server.jar"),
});
await cp(join(root, "packages/agent/dist"), join(host, "resources/agent"), {
  recursive: true,
  filter: (source) => !/\.(map|d\.ts|tsbuildinfo)$/.test(source),
});
await cp(
  join(root, "packages/agent/vendor"),
  join(host, "resources/agent/vendor"),
  { recursive: true, dereference: true }
);

// Preserve each package's dependency versions, with symlinks contained in the tar root.
const copied = new Map();
const packageAt = async (name, from) => {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    try {
      await access(join(candidate, "package.json"));
      return await realpath(candidate);
    } catch {}
    if (dirname(dir) === dir)
      throw new Error(`Missing package ${name} from ${from}`);
  }
};
const linkPackage = async (name, from, modules) => {
  const source = await packageAt(name, from);
  let destination = copied.get(source);
  if (!destination) {
    destination = join(
      host,
      "host/node_modules/.packages",
      createHash("sha256").update(source).digest("hex").slice(0, 16)
    );
    copied.set(source, destination);
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: (file) =>
        !relative(source, file).split("/").includes("node_modules"),
    });
    const pkg = JSON.parse(
      await readFile(join(source, "package.json"), "utf8")
    );
    for (const dependency of Object.keys({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    })) {
      try {
        await linkPackage(
          dependency,
          source,
          join(destination, "node_modules")
        );
      } catch (error) {
        if (!(dependency in (pkg.optionalDependencies ?? {}))) throw error;
      }
    }
  }
  const link = join(modules, name);
  await mkdir(dirname(link), { recursive: true });
  try {
    await symlink(relative(dirname(link), destination), link);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
};
for (const name of Object.keys(manifest.dependencies))
  if (!name.startsWith("@abacus-ai/"))
    await linkPackage(name, app, join(host, "host/node_modules"));
const agentExternals = [
  "@ast-grep/lang-python",
  "@ast-grep/napi",
  "@earendil-works/pi-tui",
  "@mariozechner/clipboard",
  "@silvia-odwyer/photon-node",
  "@anthropic-ai/sandbox-runtime",
  "@abacus-ai/connectors",
];
for (const name of agentExternals)
  await linkPackage(
    name,
    join(root, "packages/agent"),
    join(host, "resources/agent/node_modules")
  );
await writeFile(
  join(host, "host/runtime-packages.json"),
  JSON.stringify(
    Object.keys(manifest.dependencies).filter(
      (name) => !name.startsWith("@abacus-ai/")
    )
  )
);
await writeFile(
  join(host, "resources/agent/verify-packages.mjs"),
  `for(const name of ${JSON.stringify(agentExternals.flatMap((name) => (name === "@abacus-ai/connectors" ? ["@abacus-ai/connectors/registry", "@abacus-ai/connectors/describe", "@abacus-ai/connectors/tool-meta"] : [name])))}) await import(name);\n`
);
const tarball = join(app, "dist", `host-linux-${arch}.tar.gz`);
const preparedTarball = join(stage, `host-linux-${arch}.tar.gz`);
run("tar", ["-czf", preparedTarball, "-C", stage, "host"]);
run(process.execPath, [
  join(app, "scripts/verify-host-bundle.mjs"),
  preparedTarball,
]);
await rename(preparedTarball, tarball);
console.log(tarball);

await rm(stage, { recursive: true, force: true });
