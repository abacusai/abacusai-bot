#!/usr/bin/env node

/**
 * Fetch the binaries the agent shells out to: ripgrep and fd everywhere, and
 * on Windows busybox-w32, the POSIX shell its `bash` tool runs under.
 *
 * The agent's `grep` and `find` tools spawn `rg` and `fd` and have no JS
 * fallback. Without a shipped copy, the vendored pi agent looks on PATH and
 * then downloads a release from GitHub the first time the model searches, which
 * fails offline, behind a proxy, or on GitHub's unauthenticated rate limit. So
 * they are fetched here at build time and shipped inside the app.
 *
 * Everything is pinned and checksummed. These are executables that run on a
 * user's machine with the agent's cwd, so a floating "latest" would mean the
 * bytes we ship are whatever the release page held that morning. The checksums
 * below were verified against ripgrep's own published .sha256 sidecars; fd
 * publishes none, so its digests were taken from a download and are what any
 * later build has to reproduce.
 *
 * Idempotent, via a per-target cache under node_modules/.cache/vendor-tools/,
 * so a rebuild copies rather than re-downloading ~3MB per tool.
 *
 * Usage:
 *   node scripts/download-tools.js                    # host platform/arch
 *   node scripts/download-tools.js --arch=arm64       # cross-target
 *   node scripts/download-tools.js --platform=win32
 *
 * TARGET_ARCH is honoured too, because that is what the private packaging
 * repo's build script already exports for the matrix leg being built.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fetchVerified, run } from "@abacus-ai/config/vendor-fetch";

const RIPGREP_VERSION = "15.2.0";
// Not 10.4.2, the current release. fd stopped publishing an x86_64-apple-darwin
// build after 10.3.0, and an Intel Mac still needs an fd. The whole matrix
// stays on the last version that covers all six targets rather than carrying
// two pins and a special case.
const FD_VERSION = "10.3.0";
// The upstream build tag; src/posix-shell.ts names the same one for its cache
// directory, so a bump here is a bump there.
const BUSYBOX_VERSION = "FRP-6075-g169694ebd";

/**
 * One row per binary per target. `asset` is the release filename, `sha256` the
 * digest of that file as downloaded.
 *
 * Linux uses the musl builds on purpose: they are statically linked, so the
 * binary keeps working on a distribution older than the runner that packaged it.
 * The gnu builds carry a glibc floor, which is exactly the kind of thing that
 * only shows up on a user's machine.
 */
const TOOLS = {
  rg: {
    label: "ripgrep",
    version: RIPGREP_VERSION,
    url: (asset) =>
      `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/${asset}`,
    targets: {
      "darwin-arm64": {
        asset: `ripgrep-${RIPGREP_VERSION}-aarch64-apple-darwin.tar.gz`,
        sha256:
          "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
      },
      "darwin-x64": {
        asset: `ripgrep-${RIPGREP_VERSION}-x86_64-apple-darwin.tar.gz`,
        sha256:
          "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
      },
      "linux-arm64": {
        asset: `ripgrep-${RIPGREP_VERSION}-aarch64-unknown-linux-musl.tar.gz`,
        sha256:
          "800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915",
      },
      "linux-x64": {
        asset: `ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
        sha256:
          "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
      },
      "win32-arm64": {
        asset: `ripgrep-${RIPGREP_VERSION}-aarch64-pc-windows-msvc.zip`,
        sha256:
          "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f",
      },
      "win32-x64": {
        asset: `ripgrep-${RIPGREP_VERSION}-x86_64-pc-windows-msvc.zip`,
        sha256:
          "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5",
      },
    },
  },
  fd: {
    label: "fd",
    version: FD_VERSION,
    url: (asset) =>
      `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/${asset}`,
    targets: {
      "darwin-arm64": {
        asset: `fd-v${FD_VERSION}-aarch64-apple-darwin.tar.gz`,
        sha256:
          "0570263812089120bc2a5d84f9e65cd0c25e4a4d724c80075c357239c74ae904",
      },
      "darwin-x64": {
        asset: `fd-v${FD_VERSION}-x86_64-apple-darwin.tar.gz`,
        sha256:
          "50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3",
      },
      "linux-arm64": {
        asset: `fd-v${FD_VERSION}-aarch64-unknown-linux-musl.tar.gz`,
        sha256:
          "996b9b1366433b211cb3bbedba91c9dbce2431842144d925428ead0adf32020b",
      },
      "linux-x64": {
        asset: `fd-v${FD_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
        sha256:
          "2b6bfaae8c48f12050813c2ffe1884c61ea26e750d803df9c9114550a314cd14",
      },
      "win32-arm64": {
        asset: `fd-v${FD_VERSION}-aarch64-pc-windows-msvc.zip`,
        sha256:
          "bf9b1e31bcac71c1e95d49c56f0d872f525b95d03854e94b1d4dd6786f825cc5",
      },
      "win32-x64": {
        asset: `fd-v${FD_VERSION}-x86_64-pc-windows-msvc.zip`,
        sha256:
          "318aa2a6fa664325933e81fda60d523fff29444129e91ebf0726b5b3bcd8b059",
      },
    },
  },
  // Windows only: a stock install has no bash, and pi's tool throws without
  // one. One executable, not an archive; it dispatches on the name it is
  // invoked by, and src/posix-shell.ts makes the `sh`/`grep`/... launchers
  // at run time. GPL-2.0, spawned and never linked; build/licenses carries
  // the text. The digests match frippery.org's downloads and CodeLLM's pin.
  busybox: {
    label: "busybox-w32",
    version: BUSYBOX_VERSION,
    url: (asset) => `https://frippery.org/files/busybox/${asset}`,
    platforms: ["win32"],
    executable: true,
    targets: {
      // w64u: 64-bit x86 with Unicode (Windows 10 1903+ / Windows 11).
      "win32-x64": {
        asset: `busybox-w64u-${BUSYBOX_VERSION}.exe`,
        sha256:
          "6e263d154d8548d1eb936f65d1d8312c80df31c45974e48d6335e4dcc0f4f34c",
      },
      // w64a: 64-bit ARM, also Unicode.
      "win32-arm64": {
        asset: `busybox-w64a-${BUSYBOX_VERSION}.exe`,
        sha256:
          "e67f873d19d58c535cc9f0c4965ffd622e19b7bab87e3da89cb2185fb54464d7",
      },
    },
  },
};

/**
 * The Windows sandbox runner, `wxc-exec.exe` from Microsoft's MXC SDK, taken
 * from the npm tarball rather than the package: the package also carries
 * node-pty and the macOS and Linux runners, none of which the agent uses (see
 * src/sandbox/mxc.ts). Windows only; the other platforms confine with what the
 * OS ships. Shipped under vendor/mxc/, apart from the search tools.
 */
const MXC = {
  label: "MXC sandbox runner",
  version: "0.8.0",
  url: "https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-0.8.0.tgz",
  sha256: "06bb2399d7e98ab1907acf851e12a4e44748dd467b79d3e53c2f2fbf569da14e",
  // The runner and the two helpers it may start.
  files: ["wxc-exec.exe", "plm.exe", "winhttp-proxy-shim.exe"],
  targets: { "win32-x64": "x64", "win32-arm64": "arm64" },
};

// This script lives in packages/agent/scripts.
const ROOT = path.resolve(import.meta.dirname, "..");
// Per-target, so cross-building win32 after darwin does not re-download, and
// out of the way of anything that ships. tsdown wipes dist/ on every build.
const CACHE = path.join(ROOT, "node_modules", ".cache", "vendor-tools");
// Downloaded third-party files live in a `vendor/` directory, the same name in
// every package that has one, and deliberately NOT inside dist: tsdown clears
// dist on every build, so anything downloaded into it would have to run after
// the build and be excluded from its cache entry. See
// src/bundled-tools.ts for how it is found at run time.
const DEST = path.join(ROOT, "vendor");

function flag(name, fallback) {
  const match = process.argv
    .slice(2)
    .find((arg) => arg.startsWith(`--${name}=`));
  return match != null ? match.slice(name.length + 3) : fallback;
}

/** Extract `archive` into `dir` with whatever the host has. */
function extract(archive, dir) {
  if (process.platform === "win32") {
    // Windows ships bsdtar as tar.exe: it reads zip and sniffs gzip itself.
    // Preferred over Expand-Archive, which is markedly slower, and over Git
    // Bash's GNU tar, which cannot read zip at all and takes the colon in a
    // drive letter for a remote host.
    execFileSync(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
      ["xf", archive, "-C", dir],
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

/** The extracted binary, wherever in the archive it landed. */
function findBinary(dir, name) {
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isFile() && entry.name === name) return full;
      if (entry.isDirectory()) stack.push(full);
    }
  }

  return null;
}

async function fetchTool(tool, target, cached) {
  const config = TOOLS[tool];
  const spec = config.targets[target];

  if (spec == null) {
    throw new Error(`${config.label} has no build for ${target}`);
  }

  console.log(
    `[tools] downloading ${config.label} ${config.version} for ${target}`
  );
  const body = await fetchVerified(
    config.url(spec.asset),
    spec.sha256,
    spec.asset
  );

  // The file is the binary: nothing to extract.
  if (config.executable) {
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.writeFileSync(cached, body);
    return;
  }

  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), `abacusai-bot-${tool}-`)
  );
  const archive = path.join(scratch, spec.asset);

  try {
    fs.writeFileSync(archive, body);
    extract(archive, scratch);

    const binaryName = target.startsWith("win32-") ? `${tool}.exe` : tool;
    const extracted = findBinary(scratch, binaryName);
    if (extracted == null) {
      throw new Error(`${spec.asset}: no ${binaryName} inside the archive`);
    }

    fs.mkdirSync(path.dirname(cached), { recursive: true });
    fs.copyFileSync(extracted, cached);
    if (!target.startsWith("win32-")) fs.chmodSync(cached, 0o755);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function fetchMxc(target, cachedDir) {
  console.log(`[tools] downloading ${MXC.label} ${MXC.version} for ${target}`);
  const body = await fetchVerified(MXC.url, MXC.sha256, path.basename(MXC.url));

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-mxc-"));
  const archive = path.join(scratch, "mxc-sdk.tgz");

  try {
    fs.writeFileSync(archive, body);
    extract(archive, scratch);

    const source = path.join(scratch, "package", "bin", MXC.targets[target]);
    fs.mkdirSync(cachedDir, { recursive: true });
    for (const file of MXC.files) {
      const extracted = path.join(source, file);
      if (!fs.existsSync(extracted)) {
        throw new Error(`${path.basename(MXC.url)}: no ${file} for ${target}`);
      }
      fs.copyFileSync(extracted, path.join(cachedDir, file));
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Put the Windows runner beside the search tools, on a Windows target only. */
async function vendorMxc(target) {
  if (MXC.targets[target] == null) return;

  const cachedDir = path.join(CACHE, target, "mxc");
  if (MXC.files.every((file) => fs.existsSync(path.join(cachedDir, file)))) {
    console.log(
      `[tools] ${MXC.label} ${MXC.version} for ${target} already cached`
    );
  } else {
    await fetchMxc(target, cachedDir);
  }

  const shipped = path.join(DEST, "mxc");
  fs.mkdirSync(shipped, { recursive: true });
  for (const file of MXC.files) {
    fs.copyFileSync(path.join(cachedDir, file), path.join(shipped, file));
  }
}

async function main() {
  const platform = flag("platform", process.platform);
  const arch = flag("arch", process.env.TARGET_ARCH || process.arch);
  const target = `${platform}-${arch}`;
  const binaryExt = platform === "win32" ? ".exe" : "";

  // Cleared, not merged into. Building win32 after darwin in the same tree
  // would otherwise leave the darwin `rg` beside the new `rg.exe`, and a binary
  // for the wrong platform is worse than none: it ships, and it fails on the
  // user's machine rather than here.
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(DEST, { recursive: true });

  for (const tool of Object.keys(TOOLS)) {
    // Absent on the platforms that do not need it, rather than a dead file.
    if (
      TOOLS[tool].platforms != null &&
      !TOOLS[tool].platforms.includes(platform)
    )
      continue;
    const cached = path.join(CACHE, target, tool + binaryExt);

    if (!fs.existsSync(cached)) {
      await fetchTool(tool, target, cached);
    } else {
      console.log(
        `[tools] ${TOOLS[tool].label} ${TOOLS[tool].version} for ${target} already cached`
      );
    }

    const shipped = path.join(DEST, tool + binaryExt);
    fs.copyFileSync(cached, shipped);
    // copyFileSync keeps the mode on POSIX, but the cache may have been
    // restored by something that did not (a CI cache action, a zip round trip),
    // and a binary the agent cannot execute fails exactly like a missing one.
    if (platform !== "win32") fs.chmodSync(shipped, 0o755);
  }

  await vendorMxc(target);

  console.log(
    `[tools] ${path.relative(ROOT, DEST)} holds ${fs.readdirSync(DEST).join(", ")} for ${target}`
  );
}

run("tools", main);
