/**
 * What may be handed to `shell.openPath` ("double-click this file"). Any file
 * that exists opens, wherever it is; the forms each OS would run instead of
 * show are revealed in the file manager, including behind a link.
 */
import fs from "fs";
import os from "os";
import path from "path";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  decideLocalOpen,
  hasWindowsExecutableExtension,
} from "./local-open-guard";

/** Whether the file opens rather than being revealed or refused. */
const opensDirectly = (
  filePath: unknown,
  platform: NodeJS.Platform = process.platform
): boolean => decideLocalOpen(filePath, platform).action === "open";

let root: string;
let outside: string;

beforeAll(() => {
  // realpath'd so the macOS /tmp → /private/tmp symlink doesn't skew the
  // resolved paths the tests compare against.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "open-guard-")));
  outside = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "open-guard-outside-"))
  );
  fs.writeFileSync(path.join(root, "notes.txt"), "in");
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, "sub", "deep.txt"), "in");
  fs.writeFileSync(path.join(outside, "secret.txt"), "out");
  fs.writeFileSync(path.join(root, "evil.exe"), "mz");
  fs.writeFileSync(path.join(root, "evil.BAT"), "@echo");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "escape"));
  fs.symlinkSync(path.join(root, "evil.exe"), path.join(root, "readme.md"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe("what opens directly", () => {
  it("opens any file that exists, wherever it is", () => {
    // Desktop, Downloads, another drive: where the user asked for it to be
    // saved, or their own file the bot pointed at.
    expect(opensDirectly(path.join(root, "notes.txt"))).toBe(true);
    expect(opensDirectly(path.join(root, "sub", "deep.txt"))).toBe(true);
    expect(opensDirectly(path.join(outside, "secret.txt"))).toBe(true);
    expect(opensDirectly(path.join(root, "escape"))).toBe(true);
  });

  it("refuses only what cannot be opened at all", () => {
    expect(decideLocalOpen(path.join(root, "gone.txt"))).toEqual({
      action: "refuse",
      reason: "missing",
    });
    for (const value of [undefined, null, 42, ""]) {
      expect(decideLocalOpen(value)).toEqual({
        action: "refuse",
        reason: "invalid",
      });
    }
  });

  it("reveals executables on Windows, wherever they live", () => {
    const exe = path.join(root, "evil.exe");
    expect(opensDirectly(exe, "win32")).toBe(false);
    expect(opensDirectly(exe, "darwin")).toBe(true);
    expect(opensDirectly(exe, "linux")).toBe(true);
    // Case tricks do not help: NTFS is case-insensitive.
    expect(opensDirectly(path.join(root, "evil.BAT"), "win32")).toBe(false);
  });

  it("on Windows, checks the resolved target too: a benign link to an exe is still an exe", () => {
    const link = path.join(root, "readme.md");
    expect(opensDirectly(link, "win32")).toBe(false);
    expect(opensDirectly(link, "darwin")).toBe(true);
  });

  it("reveals the forms macOS runs on open", () => {
    for (const name of [
      "notes.command",
      "session.terminal",
      "Thing.app",
      "chore.workflow",
    ]) {
      const p = path.join(root, name);
      fs.writeFileSync(p, "x");
      try {
        expect(opensDirectly(p, "darwin")).toBe(false);
        // The same names mean nothing to the other platforms.
        expect(opensDirectly(p, "linux")).toBe(true);
      } finally {
        fs.rmSync(p, { force: true });
      }
    }
  });

  it("reveals a desktop entry on Linux", () => {
    const p = path.join(root, "report.desktop");
    fs.writeFileSync(p, "[Desktop Entry]");
    try {
      expect(opensDirectly(p, "linux")).toBe(false);
      expect(opensDirectly(p, "darwin")).toBe(true);
    } finally {
      fs.rmSync(p, { force: true });
    }
  });

  // Skipped on Windows: the execute bit these look for is a POSIX mode bit.
  const posixOnly = it.skipIf(process.platform === "win32");

  posixOnly(
    "reveals a script carrying the execute bit on macOS and Linux",
    () => {
      // A script keeps no telling extension, and the workspace is a directory
      // the agent writes to.
      const p = path.join(root, "build-something");
      fs.writeFileSync(p, "#!/bin/sh\n", { mode: 0o755 });
      try {
        expect(opensDirectly(p, "linux")).toBe(false);
        expect(opensDirectly(p, "darwin")).toBe(false);
      } finally {
        fs.rmSync(p, { force: true });
      }
    }
  );

  posixOnly(
    "reveals an executable binary by its header, not only by its name",
    () => {
      const p = path.join(root, "tool");
      fs.writeFileSync(p, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]), {
        mode: 0o755,
      });
      try {
        expect(opensDirectly(p, "linux")).toBe(false);
        expect(opensDirectly(p, "darwin")).toBe(false);
      } finally {
        fs.rmSync(p, { force: true });
      }
    }
  );

  posixOnly(
    "still opens a document on a filesystem that marks every file executable",
    () => {
      // FAT, exFAT and NTFS have no Unix permissions, so their drivers report one
      // synthesized mode for the whole mount. A workspace on a USB stick comes
      // back as 0755 for the README as much as for a binary.
      const p = path.join(root, "readme-on-a-usb-stick.md");
      fs.writeFileSync(p, "# Notes\n", { mode: 0o777 });
      try {
        expect(opensDirectly(p, "linux")).toBe(true);
        expect(opensDirectly(p, "darwin")).toBe(true);
      } finally {
        fs.rmSync(p, { force: true });
      }
    }
  );

  it("leaves ordinary documents openable on every platform", () => {
    const p = path.join(root, "notes.txt");
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(opensDirectly(p, platform)).toBe(true);
    }
  });
});

describe("decideLocalOpen", () => {
  it("reveals rather than runs a source file Windows would execute", () => {
    // `.js` is the ordinary case in a JS project. Revealing it never runs it.
    const p = path.join(outside, "app.js");
    fs.writeFileSync(p, "console.log(1)");
    try {
      expect(decideLocalOpen(p, "win32")).toEqual({
        action: "reveal",
        reason: "executable",
        path: p,
      });
      expect(decideLocalOpen(p, "darwin")).toEqual({
        action: "open",
        path: p,
      });
    } finally {
      fs.rmSync(p, { force: true });
    }
  });

  it("returns the resolved path, so the caller acts on what was checked", () => {
    // Handing the OS the path as given would let a link be re-pointed
    // between the check and the open.
    expect(decideLocalOpen(path.join(root, "escape"), "darwin")).toEqual({
      action: "open",
      path: path.join(outside, "secret.txt"),
    });
  });
});

describe("hasWindowsExecutableExtension", () => {
  it("catches the extensions Windows executes", () => {
    for (const ext of [
      ".exe",
      ".bat",
      ".cmd",
      ".com",
      ".scr",
      ".lnk",
      ".ps1",
      ".vbs",
      ".js",
      ".jse",
      ".wsf",
      ".wsh",
      ".msi",
      ".reg",
      ".hta",
      ".pif",
      ".msc",
      ".cpl",
      ".vbe",
      ".wsc",
      ".scf",
      ".url",
    ]) {
      expect(hasWindowsExecutableExtension(`C:\\x\\payload${ext}`)).toBe(true);
    }
  });

  it("is case-insensitive and ignores trailing dots and spaces", () => {
    // Windows strips trailing dots/spaces when resolving names, so
    // "evil.exe ." opens evil.exe.
    expect(hasWindowsExecutableExtension("evil.EXE")).toBe(true);
    expect(hasWindowsExecutableExtension("evil.exe.")).toBe(true);
    expect(hasWindowsExecutableExtension("evil.exe .")).toBe(true);
    expect(hasWindowsExecutableExtension("evil.eXe  ")).toBe(true);
  });

  it("passes ordinary documents", () => {
    expect(hasWindowsExecutableExtension("report.pdf")).toBe(false);
    expect(hasWindowsExecutableExtension("notes.txt")).toBe(false);
    expect(hasWindowsExecutableExtension("archive.tar.gz")).toBe(false);
    expect(hasWindowsExecutableExtension("no-extension")).toBe(false);
  });
});
