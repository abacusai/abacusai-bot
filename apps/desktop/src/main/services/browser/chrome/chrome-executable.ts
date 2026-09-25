/**
 * Where the user's Chrome is, and whether the Playwright Extension, the
 * bridge that lets an outside client drive its tabs, is installed in it.
 * Edge carries the same extension, so it is the fallback.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Pinned by the `key` in the extension's manifest, so it is the same everywhere. */
export const PLAYWRIGHT_EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm";
export const PLAYWRIGHT_EXTENSION_INSTALL_URL = `https://chromewebstore.google.com/detail/playwright-extension/${PLAYWRIGHT_EXTENSION_ID}`;

export interface ChromeInstall {
  key: "chrome" | "edge";
  name: string;
  executable: string;
  userDataDir: string;
}

const expandEnv = (value: string): string =>
  value.replace(
    /%([^%]+)%/g,
    (_match, name: string) => process.env[name] ?? ""
  );

const CANDIDATES: Array<{
  key: ChromeInstall["key"];
  name: string;
  executables: Partial<Record<NodeJS.Platform, string[]>>;
  userDataDir: Partial<Record<NodeJS.Platform, () => string>>;
}> = [
  {
    key: "chrome",
    name: "Google Chrome",
    executables: {
      darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      win32: [
        "%PROGRAMFILES%/Google/Chrome/Application/chrome.exe",
        "%PROGRAMFILES(X86)%/Google/Chrome/Application/chrome.exe",
        "%LOCALAPPDATA%/Google/Chrome/Application/chrome.exe",
      ],
      linux: [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/opt/google/chrome/chrome",
      ],
    },
    userDataDir: {
      darwin: () =>
        path.join(os.homedir(), "Library/Application Support/Google/Chrome"),
      win32: () =>
        path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/User Data"),
      linux: () => path.join(os.homedir(), ".config/google-chrome"),
    },
  },
  {
    key: "edge",
    name: "Microsoft Edge",
    executables: {
      darwin: [
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ],
      win32: [
        "%PROGRAMFILES%/Microsoft/Edge/Application/msedge.exe",
        "%PROGRAMFILES(X86)%/Microsoft/Edge/Application/msedge.exe",
      ],
      linux: ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable"],
    },
    userDataDir: {
      darwin: () =>
        path.join(os.homedir(), "Library/Application Support/Microsoft Edge"),
      win32: () =>
        path.join(process.env.LOCALAPPDATA ?? "", "Microsoft/Edge/User Data"),
      linux: () => path.join(os.homedir(), ".config/microsoft-edge"),
    },
  },
];

const exists = (file: string): boolean => {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
};

/** The first browser found, Chrome before Edge; null when neither is installed. */
export const findChrome = (
  platform: NodeJS.Platform = process.platform
): ChromeInstall | null => {
  for (const candidate of CANDIDATES) {
    const executable = (candidate.executables[platform] ?? [])
      .map(expandEnv)
      .find(exists);
    const userDataDir = candidate.userDataDir[platform]?.();
    if (executable != null && userDataDir != null) {
      return {
        key: candidate.key,
        name: candidate.name,
        executable,
        userDataDir,
      };
    }
  }
  return null;
};

/**
 * Whether the extension is installed in any profile of this user data dir.
 * A store install unpacks into `<profile>/Extensions/<id>`; a loaded one only
 * leaves a populated settings record in the preferences.
 */
export const isExtensionInstalled = (userDataDir: string): boolean => {
  let entries: string[];
  try {
    entries = fs.readdirSync(userDataDir);
  } catch {
    return false;
  }
  const profiles = entries.filter(
    (entry) => entry === "Default" || /^Profile \d+$/.test(entry)
  );
  return profiles.some((profile) => {
    const dir = path.join(userDataDir, profile);
    if (exists(path.join(dir, "Extensions", PLAYWRIGHT_EXTENSION_ID)))
      return true;
    return ["Preferences", "Secure Preferences"].some((file) => {
      try {
        const prefs = JSON.parse(
          fs.readFileSync(path.join(dir, file), "utf8")
        ) as { extensions?: { settings?: Record<string, unknown> } };
        const record = prefs.extensions?.settings?.[PLAYWRIGHT_EXTENSION_ID];
        return (
          record != null &&
          typeof record === "object" &&
          Object.keys(record).length > 0
        );
      } catch {
        return false;
      }
    });
  });
};
