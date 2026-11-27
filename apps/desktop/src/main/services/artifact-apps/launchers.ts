/**
 * Where an installed app shows up in the OS: each entry starts this app with
 * `abacusaibot://app?id=<id>`, which opens only that app's window.
 *   Linux    ~/.local/share/applications/abacusai-bot-app-<id>.desktop
 *   Windows  Start menu "AbacusAI Bot apps\<name>.lnk" and the desktop, each
 *            with its own taskbar identity; every path is also listed in
 *            <root>/shortcuts.txt, which the uninstaller removes
 *            (build/installer.nsh).
 *   macOS    ~/Applications/AbacusAI Bot apps/<name>.app, a small bundle
 *            whose script opens the link.
 */
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { app, shell } from "electron";

import { appIconPng, pngToIcns, pngToIco } from "./icon";
import { writeAtomic } from "./store";

export const APPS_FOLDER = "AbacusAI Bot apps";

export interface LauncherApp {
  id: string;
  title: string;
}

export const appLink = (id: string): string => `abacusaibot://app?id=${id}`;

/** Each app its own taskbar identity on Windows. */
export const appUserModelId = (id: string): string => `ai.abacus.bot.app.${id}`;

/** How the OS starts this app: the exe, plus the app folder in a dev run. */
const launchCommand = (): string[] => {
  if (process.env.APPIMAGE) return [process.env.APPIMAGE];
  return process.defaultApp
    ? [process.execPath, app.getAppPath()]
    : [process.execPath];
};

/** A name every OS takes as a file name. */
const fileName = (title: string): string =>
  title
    // Control characters are no part of a file name.
    // oxlint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 80) || "App";

const linuxDesktopFile = (id: string): string =>
  join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "applications",
    `abacusai-bot-app-${id}.desktop`
  );

// The .desktop spec: quote arguments holding spaces; escape `"`, `` ` ``, `$`, `\`.
const desktopQuote = (arg: string): string =>
  /[\s"`$\\]/.test(arg) ? `"${arg.replace(/(["`$\\])/g, "\\$1")}"` : arg;

const plistEscape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Writes the app's launcher entries and icons into `dir`; returns every path
 * it made, for removal later.
 */
export const writeLaunchers = async (
  entry: LauncherApp,
  dir: string
): Promise<string[]> => {
  const png = await appIconPng(entry.title, entry.id);
  writeAtomic(join(dir, "icon.png"), png);
  const link = appLink(entry.id);
  const name = fileName(entry.title);

  if (process.platform === "win32") {
    const ico = join(dir, "icon.ico");
    writeAtomic(ico, pngToIco(png));
    const [target, ...args] = launchCommand();
    const startMenu = join(
      app.getPath("appData"),
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      APPS_FOLDER
    );
    mkdirSync(startMenu, { recursive: true });
    const paths = [
      join(startMenu, `${name}.lnk`),
      join(app.getPath("desktop"), `${name}.lnk`),
    ];
    for (const at of paths)
      shell.writeShortcutLink(at, "create", {
        target: target!,
        args: [...args.map((a) => `"${a}"`), link].join(" "),
        icon: ico,
        iconIndex: 0,
        appUserModelId: appUserModelId(entry.id),
        description: entry.title,
      });
    return paths;
  }

  if (process.platform === "darwin") {
    const bundle = join(homedir(), "Applications", APPS_FOLDER, `${name}.app`);
    rmSync(bundle, { recursive: true, force: true });
    const contents = join(bundle, "Contents");
    writeAtomic(join(contents, "Resources", "icon.icns"), pngToIcns(png));
    const script = join(contents, "MacOS", "launch");
    writeAtomic(script, `#!/bin/sh\nexec /usr/bin/open "${link}"\n`);
    chmodSync(script, 0o755);
    writeAtomic(
      join(contents, "Info.plist"),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0"><dict>',
        "<key>CFBundleExecutable</key><string>launch</string>",
        "<key>CFBundleIconFile</key><string>icon</string>",
        `<key>CFBundleIdentifier</key><string>${appUserModelId(entry.id)}</string>`,
        `<key>CFBundleName</key><string>${plistEscape(entry.title)}</string>`,
        "<key>CFBundlePackageType</key><string>APPL</string>",
        "<key>CFBundleVersion</key><string>1</string>",
        // The window is this app's: no second Dock icon for the launcher.
        "<key>LSUIElement</key><true/>",
        "</dict></plist>",
        "",
      ].join("\n")
    );
    return [bundle];
  }

  const file = linuxDesktopFile(entry.id);
  const exec = [...launchCommand(), link].map(desktopQuote).join(" ");
  writeAtomic(
    file,
    [
      "[Desktop Entry]",
      "Type=Application",
      `Name=${entry.title.replace(/[\r\n]/g, " ")}`,
      `Exec=${exec}`,
      `Icon=${join(dir, "icon.png")}`,
      "Terminal=false",
      "Categories=Utility;",
      `StartupWMClass=abacusai-bot-app-${entry.id}`,
      "",
    ].join("\n")
  );
  return [file];
};

export const removeLaunchers = (paths: readonly string[]): void => {
  for (const at of paths) rmSync(at, { recursive: true, force: true });
};
