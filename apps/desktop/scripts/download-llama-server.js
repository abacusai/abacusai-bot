#!/usr/bin/env node

/**
 * Fetch the llama.cpp server the app runs local models on.
 *
 * `llama-server` is a third-party MIT binary (ggml-org/llama.cpp), so it is
 * fetched at build time rather than committed, from the project's own release
 * for the target being built: Metal on macOS, Vulkan on x64 Windows and Linux
 * (its backends load dynamically, so a machine with no usable GPU runs on the
 * CPU), CPU-only on arm64 Windows. Pinned and checksummed like every other
 * vendored binary: this one runs a model on the user's machine.
 *
 * Only the server and the libraries it loads are kept; the release also holds
 * a dozen command-line tools this app never spawns.
 *
 * Idempotent, via a per-target cache under apps/desktop/vendor/llama/, so a
 * rebuild copies rather than re-downloading ~30 MB.
 *
 * Usage:
 *   node scripts/download-llama-server.js                 # host platform/arch
 *   node scripts/download-llama-server.js --arch=arm64    # cross-target
 *   node scripts/download-llama-server.js --platform=win32
 *
 * TARGET_ARCH is honoured too, as in the agent's download-tools.js.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fetchVerified, run } from "@abacus-ai/config/vendor-fetch";

// The upstream build tag. main/services/local-models/llama-server.ts names
// the same one in its logs, so a bump here is a bump there.
const VERSION = "b11102";

/** One row per target: the release asset and the digest of that file as downloaded. */
const TARGETS = {
  "darwin-arm64": {
    asset: `llama-${VERSION}-bin-macos-arm64.tar.gz`,
    sha256: "a9c9fd52691d2fdd801c0f092c518919cf46490c791b3a88914a4af682357234",
  },
  "darwin-x64": {
    asset: `llama-${VERSION}-bin-macos-x64.tar.gz`,
    sha256: "8df070b0bb9c7454e1540f05f1c285c8919e0ab7c39fa7dec15b3cb793d80a3b",
  },
  "linux-arm64": {
    asset: `llama-${VERSION}-bin-ubuntu-vulkan-arm64.tar.gz`,
    sha256: "f0d7181d55b2b9e727f6596e3f518e25df838969733e09386c2d043df343aba9",
  },
  "linux-x64": {
    asset: `llama-${VERSION}-bin-ubuntu-vulkan-x64.tar.gz`,
    sha256: "ae1eb5bb3518c87e8d36d1a47fefe66b7e6acef6c51ae273fa11256957042c85",
  },
  "win32-arm64": {
    asset: `llama-${VERSION}-bin-win-cpu-arm64.zip`,
    sha256: "15dfbd98b59c84aa826dc3599db40231036ac3a8b80988cf6eed42dfe22bf36a",
  },
  "win32-x64": {
    asset: `llama-${VERSION}-bin-win-vulkan-x64.zip`,
    sha256: "dbadded6d58e9adaeb69dcacc3740e96291cf77e890146beaa28e4078d7c2c66",
  },
};

const ROOT = path.resolve(import.meta.dirname, "..");
// Downloaded third-party files go in `vendor/`, and this app's resources
// directory ships verbatim, so this is already the packaged path.
const DEST = path.join(ROOT, "resources", "vendor", "llama");
// Per-target, so cross-building win32 after darwin does not re-download.
const CACHE = path.join(ROOT, "vendor", "llama");

function flag(name, fallback) {
  const arg = process.argv
    .slice(2)
    .find((value) => value.startsWith(`--${name}=`));

  return arg ? arg.slice(name.length + 3) : fallback;
}

function extract(archive, dir) {
  if (process.platform === "win32") {
    // Windows ships bsdtar as tar.exe: it reads zip and sniffs gzip itself.
    execFileSync(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
      ["-xf", archive, "-C", dir],
      { stdio: "pipe" }
    );
    return;
  }
  if (archive.endsWith(".zip")) {
    execFileSync("unzip", ["-q", archive, "-d", dir], { stdio: "pipe" });
    return;
  }
  execFileSync("tar", ["xzf", archive, "-C", dir], { stdio: "pipe" });
}

/**
 * What the server needs beside it and nothing else: the executable, its own
 * implementation library, and the runtime libraries (llama, ggml and its
 * backends, mtmd). The other `*-impl` libraries belong to tools not shipped.
 */
function wanted(name) {
  if (/^llama-server(\.exe)?$/.test(name)) return true;
  if (name.startsWith("LICENSE")) return true;
  if (/-impl\.(dylib|so|dll)$/.test(name))
    return name.includes("llama-server-impl");
  return (
    /^(lib)?(llama|ggml|mtmd|llama-common)[^/]*\.(dylib|so(\.\d+)*|dll)$/.test(
      name
    ) ||
    /^libomp.*\.dll$/.test(name) ||
    /^vulkan-1\.dll$/.test(name) ||
    name === "ggml-metal-tuning"
  );
}

/** Every file in the extracted tree, with symlinks kept as symlinks. */
function collect(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else out.push(full);
  }
  return out;
}

async function fetchServer(target, cachedDir) {
  const spec = TARGETS[target];
  if (spec == null) throw new Error(`llama.cpp has no build for ${target}`);

  console.log(`[llama] downloading llama.cpp ${VERSION} for ${target}`);
  const body = await fetchVerified(
    `https://github.com/ggml-org/llama.cpp/releases/download/${VERSION}/${spec.asset}`,
    spec.sha256,
    spec.asset
  );

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "abacus-llama-"));
  try {
    const archive = path.join(scratch, spec.asset);
    fs.writeFileSync(archive, body);
    const unpacked = path.join(scratch, "unpacked");
    fs.mkdirSync(unpacked);
    extract(archive, unpacked);

    fs.rmSync(cachedDir, { recursive: true, force: true });
    fs.mkdirSync(cachedDir, { recursive: true });
    let server = false;
    for (const file of collect(unpacked)) {
      const name = path.basename(file);
      if (!wanted(name)) continue;
      const dest = path.join(cachedDir, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        // The versioned library names on macOS and Linux are symlink chains;
        // copying them as files would ship three copies of every library.
        fs.symlinkSync(fs.readlinkSync(file), dest);
      } else {
        fs.copyFileSync(file, dest);
      }
      if (/^llama-server(\.exe)?$/.test(name)) server = true;
    }
    if (!server) throw new Error(`${spec.asset}: no llama-server inside`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const platform = flag("platform", process.platform);
  const arch = flag("arch", process.env.TARGET_ARCH || process.arch);
  const target = `${platform}-${arch}`;
  const cachedDir = path.join(CACHE, target);
  const exe = platform === "win32" ? "llama-server.exe" : "llama-server";

  if (!fs.existsSync(path.join(cachedDir, exe))) {
    await fetchServer(target, cachedDir);
  } else {
    console.log(`[llama] llama.cpp ${VERSION} for ${target} already cached`);
  }

  // Cleared, not merged into: a library for the wrong platform is worse than
  // none. It ships, and fails on the user's machine rather than here.
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(DEST, { recursive: true });
  for (const entry of fs.readdirSync(cachedDir, { withFileTypes: true })) {
    const from = path.join(cachedDir, entry.name);
    const to = path.join(DEST, entry.name);
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), to);
      continue;
    }
    fs.copyFileSync(from, to);
    // The cache may have been restored by something that dropped the mode (a
    // CI cache action, a zip round trip), and a server the app cannot execute
    // fails exactly like a missing one.
    if (platform !== "win32") fs.chmodSync(to, 0o755);
  }

  console.log(
    `[llama] ${path.relative(ROOT, DEST)} holds llama-server ${VERSION} for ${target} (${fs.readdirSync(DEST).length} files)`
  );
}

run("llama", main);
