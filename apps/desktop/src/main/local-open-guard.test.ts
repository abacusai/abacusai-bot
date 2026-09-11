/**
 * What may be handed to `shell.openPath` — "double-click this file". The paths
 * reaching it include file links out of model-generated markdown, so the guard
 * must hold against traversal, symlink escapes, and the forms each OS runs
 * instead of showing — not just honest paths.
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

/** Shorthand for the containment and executable-form checks together. */
const opensDirectly = (
  filePath: unknown,
  roots: readonly string[],
  platform: NodeJS.Platform = process.platform
): boolean => decideLocalOpen(filePath, roots, platform).action === "open";

let root: string;
let outside: string;

beforeAll(() => {
  // realpath'd so the macOS /tmp → /private/tmp symlink doesn't skew the
  // containment assertions the tests make about their own fixtures.
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

describe("what may be opened directly", () => {
  it("allows files inside an allowed root, at any depth", () => {
    expect(opensDirectly(path.join(root, "notes.txt"), [root])).toBe(true);
    expect(opensDirectly(path.join(root, "sub", "deep.txt"), [root])).toBe(
      true
    );
    expect(opensDirectly(root, [root])).toBe(true);
  });

  it("checks every allowed root, not just the first", () => {
    expect(opensDirectly(path.join(root, "notes.txt"), [outside, root])).toBe(
      true
    );
  });

  it("refuses paths outside every allowed root", () => {
    expect(opensDirectly(path.join(outside, "secret.txt"), [root])).toBe(false);
    expect(opensDirectly("/etc/hosts", [root])).toBe(false);
  });

  it("refuses traversal that dresses an outside path in an inside prefix", () => {
    const dressed = path.join(root, "..", path.basename(outside), "secret.txt");
    expect(opensDirectly(dressed, [root])).toBe(false);
  });

  it("is boundary-aware, not a string-prefix match", () => {
    const sibling = `${root}-sibling`;
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, "x.txt"), "out");
    try {
      expect(opensDirectly(path.join(sibling, "x.txt"), [root])).toBe(false);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("refuses a symlink inside the root that points outside it", () => {
    // Lexically root/escape is inside; its realpath is not, and the realpath
    // is what the OS would open.
    expect(opensDirectly(path.join(root, "escape"), [root])).toBe(false);
  });

  it("resolves symlinked roots before comparing", () => {
    const linkedRoot = path.join(outside, "root-link");
    fs.symlinkSync(root, linkedRoot);
    try {
      expect(opensDirectly(path.join(root, "notes.txt"), [linkedRoot])).toBe(
        true
      );
    } finally {
      fs.rmSync(linkedRoot, { force: true });
    }
  });

  it("refuses paths that do not exist — there is nothing legitimate to open", () => {
    expect(opensDirectly(path.join(root, "missing.txt"), [root])).toBe(false);
    expect(opensDirectly("\\\\attacker\\share\\payload.bat", [root])).toBe(
      false
    );
  });

  it("refuses non-strings, empty strings, and empty root lists", () => {
    expect(opensDirectly(undefined, [root])).toBe(false);
    expect(opensDirectly(null, [root])).toBe(false);
    expect(opensDirectly(42, [root])).toBe(false);
    expect(opensDirectly("", [root])).toBe(false);
    expect(opensDirectly(path.join(root, "notes.txt"), [])).toBe(false);
  });

  it("refuses executables on Windows, wherever they live", () => {
    const exe = path.join(root, "evil.exe");
    expect(opensDirectly(exe, [root], "win32")).toBe(false);
    expect(opensDirectly(exe, [root], "darwin")).toBe(true);
    expect(opensDirectly(exe, [root], "linux")).toBe(true);
    // Case tricks do not help: NTFS is case-insensitive.
    expect(opensDirectly(path.join(root, "evil.BAT"), [root], "win32")).toBe(
      false
    );
  });

  it("on Windows, checks the resolved target too — a benign link to an exe is still an exe", () => {
    const link = path.join(root, "readme.md");
    expect(opensDirectly(link, [root], "win32")).toBe(false);
    expect(opensDirectly(link, [root], "darwin")).toBe(true);
  });

  it("refuses the forms macOS runs on open", () => {
    for (const name of [
      "notes.command",
      "session.terminal",
      "Thing.app",
      "chore.workflow",
    ]) {
      const p = path.join(root, name);
      fs.writeFileSync(p, "x");
      try {
        expect(opensDirectly(p, [root], "darwin")).toBe(false);
        // The same names mean nothing to the other platforms.
        expect(opensDirectly(p, [root], "linux")).toBe(true);
      } finally {
        fs.rmSync(p, { force: true });
      }
    }
  });

  it("refuses a desktop entry on Linux", () => {
    const p = path.join(root, "report.desktop");
    fs.writeFileSync(p, "[Desktop Entry]");
    try {
      expect(opensDirectly(p, [root], "linux")).toBe(false);
      expect(opensDirectly(p, [root], "darwin")).toBe(true);
    } finally {
      fs.rmSync(p, { force: true });
    }
  });

  // Skipped on Windows: the execute bit these look for is a POSIX mode bit.
  const posixOnly = it.skipIf(process.platform === "win32");

  posixOnly(
    "refuses a script carrying the execute bit on macOS and Linux",
    () => {
      // A script keeps no telling extension, and the workspace is a directory
      // the agent writes to.
      const p = path.join(root, "build-something");
      fs.writeFileSync(p, "#!/bin/sh\n", { mode: 0o755 });
      try {
        expect(opensDirectly(p, [root], "linux")).toBe(false);
        expect(opensDirectly(p, [root], "darwin")).toBe(false);
      } finally {
        fs.rmSync(p, { force: true });
      }
    }
  );

  posixOnly(
    "refuses an executable binary by its header, not only by its name",
    () => {
      const p = path.join(root, "tool");
      fs.writeFileSync(p, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]), {
        mode: 0o755,
      });
      try {
        expect(opensDirectly(p, [root], "linux")).toBe(false);
        expect(opensDirectly(p, [root], "darwin")).toBe(false);
      } finally {
        fs.rmSync(p, { force: true });
      }
    }
  );

  posixOnly(
    "still opens a document on a filesystem that marks every file executable",
    () => {
      // FAT, exFAT and NTFS have no Unix permissions, so their drivers report one
      // synthesized mode for the whole mount — a workspace on a USB stick comes
      // back as 0755 for the README as much as for a binary.
      const p = path.join(root, "readme-on-a-usb-stick.md");
      fs.writeFileSync(p, "# Notes\n", { mode: 0o777 });
      try {
        expect(opensDirectly(p, [root], "linux")).toBe(true);
        expect(opensDirectly(p, [root], "darwin")).toBe(true);
      } finally {
        fs.rmSync(p, { force: true });
      }
    }
  );

  it("leaves ordinary documents openable on every platform", () => {
    const p = path.join(root, "notes.txt");
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(opensDirectly(p, [root], platform)).toBe(true);
    }
  });
});

describe("decideLocalOpen", () => {
  it("reveals rather than runs a source file Windows would execute", () => {
    // `.js` is the ordinary case in a JS project. Refusing the click outright
    // left the button dead; revealing it never runs the file.
    const p = path.join(root, "app.js");
    fs.writeFileSync(p, "console.log(1)");
    try {
      expect(decideLocalOpen(p, [root], "win32")).toEqual({
        action: "reveal",
        reason: "executable",
        path: p,
      });
      expect(decideLocalOpen(p, [root], "darwin")).toEqual({
        action: "open",
        path: p,
      });
    } finally {
      fs.rmSync(p, { force: true });
    }
  });

  it("returns the resolved path, so the caller acts on what was checked", () => {
    // The decision is made about the resolved file. Handing the OS the path as
    // given would let a link be re-pointed between the check and the open.
    const link = path.join(root, "notes-link.txt");
    fs.symlinkSync(path.join(root, "notes.txt"), link);
    try {
      expect(decideLocalOpen(link, [root], "darwin")).toEqual({
        action: "open",
        path: path.join(root, "notes.txt"),
      });
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it("separates a refusal from a reveal, so the reason can be reported", () => {
    expect(decideLocalOpen(path.join(outside, "secret.txt"), [root])).toEqual({
      action: "refuse",
      reason: "outside",
    });
    expect(decideLocalOpen(path.join(root, "gone.txt"), [root])).toEqual({
      action: "refuse",
      reason: "missing",
    });
    expect(decideLocalOpen("", [root])).toEqual({
      action: "refuse",
      reason: "invalid",
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

/**
 * The temp directory is an allowed root because that is where the agent writes
 * scratch files — a plot written to /tmp and linked in the reply has to open.
 * On Linux that directory is shared with every other local account, so what
 * separates ours from theirs is who owns the file.
 */
describe("files in the shared temp directory", () => {
  // A real directory in the real temp directory — that is the point of these
  // cases — but its own, so two test workers on one machine cannot collide.
  const scratch = (): string => {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "open-guard-scratch-"))
    );
    const file = path.join(dir, "plot.png.txt");

    fs.writeFileSync(file, "plot");
    scratchDirs.push(dir);

    return file;
  };

  const scratchDirs: string[] = [];

  afterEach(() => {
    while (scratchDirs.length > 0) {
      fs.rmSync(scratchDirs.pop() as string, {
        recursive: true,
        force: true,
      });
    }
  });

  it("opens a scratch file this user wrote there", () => {
    const file = scratch();

    expect(decideLocalOpen(file, [os.tmpdir()], "linux")).toEqual({
      action: "open",
      path: file,
    });
  });

  // The guard compares the file's owner against `process.getuid()`, which
  // Windows does not have — and does not need, since it gives every account its
  // own temp directory. Passing `"linux"` cannot conjure a uid to compare, so
  // the case is one this platform has no way to be wrong about.
  it.skipIf(process.getuid == null)(
    "refuses one belonging to another account on the machine",
    () => {
      const file = scratch();
      const real = fs.statSync.bind(fs);

      vi.spyOn(fs, "statSync").mockImplementation(((target: string) => {
        const info = real(target) as fs.Stats;

        return target === file ? { ...info, uid: info.uid + 1 } : info;
      }) as typeof fs.statSync);

      try {
        expect(decideLocalOpen(file, [os.tmpdir()], "linux")).toEqual({
          action: "refuse",
          reason: "outside",
        });
      } finally {
        vi.restoreAllMocks();
      }
    }
  );

  it("asks the question only where the directory is shared", () => {
    // macOS and Windows give each account its own temp directory already, and
    // a stat there would only cost time.
    const file = scratch();
    const real = fs.statSync.bind(fs);

    vi.spyOn(fs, "statSync").mockImplementation(((target: string) => {
      const info = real(target) as fs.Stats;

      return target === file ? { ...info, uid: info.uid + 1 } : info;
    }) as typeof fs.statSync);

    try {
      expect(decideLocalOpen(file, [os.tmpdir()], "darwin").action).toBe(
        "open"
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});
