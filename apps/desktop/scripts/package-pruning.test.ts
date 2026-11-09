import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const require = createRequire(import.meta.url);
const afterPack = require("./after-pack.cjs");
const { Arch, WinPackager } = require("electron-builder");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture(platform: string, arch: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "package-pruning-"));
  roots.push(root);
  const resources = path.join(root, "resources");
  const framework = path.join(root, "framework");
  const locales =
    platform === "darwin" ? framework : path.join(root, "locales");
  const modules = path.join(resources, "agent/node_modules");
  const write = (file: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "fixture");
    return file;
  };
  const locale = (name: string) =>
    write(
      path.join(
        locales,
        platform === "darwin" ? `${name}.lproj/locale.pak` : `${name}.pak`
      )
    );
  const signed: string[] = [];
  const run = () =>
    afterPack({
      appOutDir: root,
      electronPlatformName: platform,
      arch: Arch[arch],
      packager: {
        getResourcesDir: () => resources,
        getMacOsElectronFrameworkResourcesDir: () => framework,
        signIf: async (file: string) => {
          signed.push(file);
          return true;
        },
      },
    });
  return { root, resources, modules, write, locale, run, signed };
}

it.each(
  ["darwin", "linux", "win32"].flatMap((platform) =>
    ["x64", "arm64"].map((arch) => [platform, arch])
  )
)(
  "prunes %s/%s while preserving runtime assets and supported locales",
  async (platform, arch) => {
    const f = fixture(platform!, arch!);
    const keep = [
      "en",
      "en-US",
      "en_GB",
      "de",
      "es",
      "es_419",
      "pt_BR",
      "pt-PT",
      "fr_FEMININE",
      "tr",
      "id",
      "it",
      "ja",
      "ko",
      "zh_CN",
      "zh_TW",
      "zh-CN",
      "zh-TW",
    ].map(f.locale);
    const remove = ["ru", "ar_NEUTER"].map(f.locale);
    for (const name of [
      "icudtl.dat",
      "resources.pak",
      "snapshot_blob.bin",
      "v8_context_snapshot.bin",
      "libEGL.dll",
      "app-update.yml",
      "LICENSE",
      "THIRD-PARTY-NOTICES.txt",
    ]) {
      keep.push(f.write(path.join(f.resources, name)));
    }
    for (const name of [
      "index.js",
      "image.wasm",
      "addon.node",
      "LICENSE.md",
      "data.json",
    ]) {
      keep.push(f.write(path.join(f.modules, "runtime", name)));
    }
    for (const name of [
      "index.js.map",
      "index.d.ts",
      "index.d.cts",
      "index.d.mts",
      ".tsbuildinfo",
    ]) {
      remove.push(f.write(path.join(f.modules, "runtime", name)));
    }
    keep.push(f.write(path.join(f.resources, "icon2.png")));
    remove.push(f.write(path.join(f.resources, "icon.ico")));
    (platform === "darwin" ? keep : remove).push(
      f.write(path.join(f.resources, "icon.icns"))
    );
    keep.push(f.write(path.join(f.resources, "LICENSES.chromium.html")));
    (platform === "darwin" ? keep : remove).push(
      f.write(path.join(f.root, "LICENSES.chromium.html"))
    );
    for (const name of [
      "zod/index.js",
      "zod/index.cjs",
      "zod/LICENSE",
      "node-forge/lib/index.js",
      "node-forge/LICENSE",
    ]) {
      keep.push(f.write(path.join(f.modules, name)));
    }
    for (const name of ["zod/src/index.ts", "node-forge/dist/forge.min.js"]) {
      remove.push(f.write(path.join(f.modules, name)));
    }
    const parser = path.join(f.modules, "@ast-grep/lang-python");
    const osName = { darwin: "macOS", linux: "Linux", win32: "Windows" }[
      platform!
    ];
    for (const targetOS of ["macOS", "Linux", "Windows"]) {
      for (const targetArch of ["X64", "ARM64"]) {
        const file = f.write(
          path.join(
            parser,
            "prebuilds",
            `prebuild-${targetOS}-${targetArch}`,
            "parser.so"
          )
        );
        (targetOS === osName && targetArch === arch!.toUpperCase()
          ? keep
          : remove
        ).push(file);
      }
    }
    remove.push(f.write(path.join(parser, "src/parser.c")));
    const vendor = path.join(f.modules, "@anthropic-ai/sandbox-runtime/vendor");
    keep.push(
      f.write(path.join(vendor, "java-proxy-agent/srt-proxy-agent.jar"))
    );
    for (const [name, targetOS] of [
      ["seccomp", "linux"],
      ["srt-win", "win32"],
    ]) {
      for (const targetArch of ["x64", "arm64"]) {
        const file = f.write(path.join(vendor, name!, targetArch, "binary"));
        (targetOS === platform && targetArch === arch ? keep : remove).push(
          file
        );
      }
    }
    await f.run();
    expect(keep.filter((file) => !fs.existsSync(file))).toEqual([]);
    expect(remove.filter((file) => fs.existsSync(file))).toEqual([]);
    // Windows signs the one grammar it keeps; no other platform signs here.
    expect(f.signed).toEqual(
      platform === "win32"
        ? [
            path.join(
              parser,
              "prebuilds",
              `prebuild-Windows-${arch!.toUpperCase()}`,
              "parser.so"
            ),
          ]
        : []
    );
    await f.run(); // Idempotent if electron-builder retries packaging.
  }
);

it("keeps parser sources and prebuilds when the target has no parser", async () => {
  const f = fixture("win32", "arm64");
  const parser = path.join(f.modules, "@ast-grep/lang-python");
  const source = f.write(path.join(parser, "src/parser.c"));
  const prebuilt = f.write(
    path.join(parser, "prebuilds/prebuild-Windows-X64/parser.so")
  );
  await f.run();
  expect(fs.existsSync(source)).toBe(true);
  expect(fs.existsSync(prebuilt)).toBe(true);
});

it("keeps all native architectures for a universal macOS app", async () => {
  const f = fixture("darwin", "universal");
  const files = ["X64", "ARM64"].map((arch) =>
    f.write(
      path.join(
        f.modules,
        `@ast-grep/lang-python/prebuilds/prebuild-macOS-${arch}/parser.so`
      )
    )
  );
  await f.run();
  expect(files.every((file) => fs.existsSync(file))).toBe(true);
});

it.skipIf(process.platform === "win32")(
  "does not follow agent dependency symlinks",
  async () => {
    const f = fixture("linux", "x64");
    const input = f.write(path.join(f.root, "build-input/index.js.map"));
    fs.mkdirSync(f.modules, { recursive: true });
    fs.symlinkSync(path.dirname(input), path.join(f.modules, "linked"), "dir");
    await f.run();
    expect(fs.existsSync(input)).toBe(true);
  }
);

it("signs every native file a Windows build ships, and nothing it cannot sign", () => {
  const config = parseYaml(
    fs.readFileSync(
      path.join(import.meta.dirname, "../electron-builder.yml"),
      "utf8"
    )
  ) as {
    win: { signExts?: string[]; extraResources?: { from: string }[] };
    mac: { extraResources?: { from: string }[] };
    extraResources: { from: string; filter?: string[] }[];
  };
  // electron-builder's own rule, for its copy of extraResources and its walk
  // of app.asar.unpacked.
  const signs = (file: string): boolean =>
    WinPackager.prototype.shouldSignFile.call(
      { platformSpecificBuildOptions: config.win },
      file
    );
  const agent = "resources/agent/node_modules";
  const unpacked = "resources/app.asar.unpacked/node_modules";
  for (const file of [
    "AbacusBot.exe",
    "ffmpeg.dll",
    `${agent}/@ast-grep/napi-win32-x64-msvc/ast-grep-napi.win32-x64-msvc.node`,
    `${agent}/@earendil-works/pi-tui/native/win32/prebuilds/win32-x64/win32-console-mode.node`,
    `${unpacked}/@lydell/node-pty-win32-x64/prebuilds/win32-x64/pty.node`,
    `${unpacked}/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty/conpty.dll`,
    `${unpacked}/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty/OpenConsole.exe`,
    `${unpacked}/@yuuang/ffi-rs-win32-x64-msvc/ffi-rs.win32-x64-msvc.node`,
    `${unpacked}/@ff-labs/fff-bin-win32-x64/fff_c.dll`,
    `${unpacked}/@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node`,
  ]) {
    expect(signs(file), file).toBe(true);
  }
  // Signed at copy time, so these must not be copied there: every platform's
  // grammar is (after-pack.cjs prunes, then signs the kept one), and pi-tui's
  // macOS addon would be, but ships only to macOS.
  expect(
    signs(
      `${agent}/@ast-grep/lang-python/prebuilds/prebuild-Linux-X64/parser.so`
    )
  ).toBe(false);
  const piTui = config.extraResources.find((entry) =>
    entry.from.includes("pi-tui")
  );
  expect(piTui?.filter).toContain("!native/**");
  expect(config.win.extraResources?.map((entry) => entry.from)).toEqual([
    "../../node_modules/@earendil-works/pi-tui/native/win32/",
  ]);
  expect(config.mac.extraResources?.map((entry) => entry.from)).toEqual([
    "../../node_modules/@earendil-works/pi-tui/native/darwin/",
  ]);
});
