import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const afterPack = require("../../scripts/after-pack.cjs");
const { Arch } = require("builder-util");
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
  const run = () =>
    afterPack({
      appOutDir: root,
      electronPlatformName: platform,
      arch: Arch[arch],
      packager: {
        getResourcesDir: () => resources,
        getMacOsElectronFrameworkResourcesDir: () => framework,
      },
    });
  return { root, resources, modules, write, locale, run };
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
      "hi",
      "id",
      "it",
      "ja",
      "ko",
    ].map(f.locale);
    const remove = ["ru", "zh_CN", "ar_NEUTER"].map(f.locale);
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
