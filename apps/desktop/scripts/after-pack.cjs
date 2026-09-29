const fs = require("node:fs/promises");
const path = require("node:path");
const { Arch } = require("builder-util");

// Run before signing and before installers, blockmaps and update hashes exist.
// Only the staged app is changed; node_modules and build inputs stay intact.
module.exports = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const resources = packager.getResourcesDir(appOutDir);
  const arch = Arch[context.arch];
  let removedBytes = 0;
  let removedFiles = 0;

  async function entries(dir) {
    try {
      return await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function remove(file) {
    const stat = await fs.lstat(file).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) return;
    // Never follow a symlink into a build input or another part of the app.
    if (stat.isDirectory()) {
      for (const entry of await entries(file)) {
        await remove(path.join(file, entry.name));
      }
      await fs.rmdir(file);
    } else {
      removedBytes += stat.size;
      removedFiles += 1;
      await fs.unlink(file);
    }
  }

  // Keep every Chromium regional/gender variant of a language the UI supports.
  // macOS uses underscores and .lproj; Windows/Linux use hyphens and .pak.
  // English remains the fallback for unsupported UI languages. Do not touch
  // ICU data, dictionaries, graphics libraries, snapshots or general .pak files.
  const localeSource = path.join(__dirname, "../src/renderer/locales");
  const languages = new Set(
    (await entries(localeSource))
      .filter((entry) => entry.name.endsWith(".json"))
      .map((entry) => entry.name.split(/[-_.]/)[0].toLowerCase())
  );
  if (!languages.has("en")) throw new Error("Missing English UI locale");
  const localeDirs =
    electronPlatformName === "darwin"
      ? [resources, packager.getMacOsElectronFrameworkResourcesDir(appOutDir)]
      : [path.join(appOutDir, "locales")];
  for (const dir of localeDirs) {
    for (const entry of await entries(dir)) {
      const match = /^([a-z]{2,3})(?:[-_][\w-]+)?\.(?:pak|lproj)$/i.exec(
        entry.name
      );
      if (match && !languages.has(match[1].toLowerCase())) {
        await remove(path.join(dir, entry.name));
      }
    }
  }

  // extraResources does not receive electron-builder's node_modules exclusions.
  const agentModules = path.join(resources, "agent/node_modules");
  async function removeBuildMetadata(dir) {
    for (const entry of await entries(dir)) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await removeBuildMetadata(file);
      else if (/\.(?:map|d\.[cm]?ts|tsbuildinfo)$/.test(entry.name))
        await remove(file);
    }
  }
  await removeBuildMetadata(agentModules);

  // These loaders select the target's exact OS/architecture, with no fallback
  // to a different architecture. Unknown/universal targets retain all binaries.
  if (["x64", "arm64"].includes(arch)) {
    const parser = path.join(agentModules, "@ast-grep/lang-python");
    const os = { darwin: "macOS", linux: "Linux", win32: "Windows" }[
      electronPlatformName
    ];
    const selected = `prebuild-${os}-${arch.toUpperCase()}`;
    const prebuilds = path.join(parser, "prebuilds");
    // Keep sources if the target has no prebuilt parser or compiled fallback.
    const hasParser = await fs
      .access(path.join(prebuilds, selected, "parser.so"))
      .then(
        () => true,
        () => false
      );
    const hasFallback = await fs.access(path.join(parser, "parser.so")).then(
      () => true,
      () => false
    );
    if (os && (hasParser || hasFallback)) {
      for (const entry of await entries(prebuilds)) {
        if (entry.name !== selected && entry.name.startsWith("prebuild-")) {
          await remove(path.join(prebuilds, entry.name));
        }
      }
      await remove(path.join(parser, "src"));
    }

    const vendor = path.join(
      agentModules,
      "@anthropic-ai/sandbox-runtime/vendor"
    );
    for (const [name, platform] of [
      ["seccomp", "linux"],
      ["srt-win", "win32"],
    ]) {
      if (electronPlatformName !== platform)
        await remove(path.join(vendor, name));
      else {
        for (const other of ["x64", "arm64"]) {
          if (other !== arch) await remove(path.join(vendor, name, other));
        }
      }
    }
  }
  console.log(
    `[package-size] removed ${removedFiles} unused files, ${removedBytes} bytes (${electronPlatformName}/${arch})`
  );
};
