/**
 * The button that erases everything, checked for the two ways it could go
 * wrong: deleting the wrong directory, or not deleting at all.
 *
 * The first matters more than it looks. `ABACUSAI_BOT_HOME` is how a developer
 * runs against an isolated directory, and it is set on machines that also have
 * a real `~/.abacusai-bot` full of real keys. Composing the path from
 * `os.homedir()` here instead of reading it through `abacusBotHome()` would
 * make this delete the wrong one — silently, and only for the people working on
 * it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  eraseUserData,
  finishPendingErase,
  pendingEraseMarkerPath,
} from "./delete-all-data";

let sandbox: string;
const original = process.env.ABACUSAI_BOT_HOME;
const originalBase = process.env.ABACUSAI_BOT_BASE;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "erase-"));
});

afterEach(() => {
  if (original == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = original;
  if (originalBase == null) delete process.env.ABACUSAI_BOT_BASE;
  else process.env.ABACUSAI_BOT_BASE = originalBase;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const seed = (dir: string): void => {
  fs.mkdirSync(path.join(dir, "skills", "deck"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), '{"key":"sk-secret"}');
  fs.writeFileSync(path.join(dir, "skills", "deck", "SKILL.md"), "# deck");
};

describe("erasing the data directory", () => {
  it("deletes the directory the app actually reads from", () => {
    const home = path.join(sandbox, ".abacusai-bot");
    process.env.ABACUSAI_BOT_HOME = home;
    seed(home);

    return eraseUserData().then((deleted) => {
      expect(deleted).toBe(home);
      expect(fs.existsSync(home)).toBe(false);
    });
  });

  it("honours ABACUSAI_BOT_HOME instead of the real home directory", async () => {
    // The regression this exists for: a delete that resolves ~/.abacusai-bot on
    // its own would take a developer's real keys with it.
    const isolated = path.join(sandbox, "isolated");
    process.env.ABACUSAI_BOT_HOME = isolated;
    seed(isolated);

    const realHome = path.join(os.homedir(), ".abacusai-bot");

    expect(await eraseUserData()).toBe(isolated);
    expect(path.resolve(isolated)).not.toBe(path.resolve(realHome));
  });

  it("takes nested content with it, not just the top-level files", async () => {
    const home = path.join(sandbox, ".abacusai-bot");
    process.env.ABACUSAI_BOT_HOME = home;
    seed(home);

    await eraseUserData();

    expect(fs.existsSync(path.join(home, "skills", "deck", "SKILL.md"))).toBe(
      false
    );
  });

  it("deletes every account profile from the profile base", async () => {
    const base = path.join(sandbox, ".abacusai-bot");
    process.env.ABACUSAI_BOT_BASE = base;
    process.env.ABACUSAI_BOT_HOME = path.join(base, "profiles", "account-a");
    seed(process.env.ABACUSAI_BOT_HOME);
    seed(path.join(base, "profiles", "account-b"));
    fs.writeFileSync(
      path.join(base, "profiles.json"),
      JSON.stringify({
        active: "account-a",
        profiles: {
          "account-a": "profiles/account-a",
          "account-b": "profiles/account-b",
        },
      })
    );

    await expect(eraseUserData()).resolves.toBe(base);
    expect(fs.existsSync(base)).toBe(false);
  });

  it("also removes the pre-profile Electron storage directory", async () => {
    const base = path.join(sandbox, ".abacusai-bot");
    const legacy = path.join(sandbox, "Library", "Application Support", "Bot");
    process.env.ABACUSAI_BOT_BASE = base;
    seed(base);
    seed(legacy);

    await eraseUserData([legacy]);

    expect(fs.existsSync(base)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it("is not an error when there is nothing there", async () => {
    process.env.ABACUSAI_BOT_HOME = path.join(sandbox, "never-created");

    await expect(eraseUserData()).resolves.toBeTypeOf("string");
  });

  it("refuses a filesystem root, whatever the config says", async () => {
    process.env.ABACUSAI_BOT_HOME = path.parse(sandbox).root;

    await expect(eraseUserData()).rejects.toThrow(/Refusing to delete/);
  });

  it("validates legacy paths before deleting the profile base", async () => {
    const base = path.join(sandbox, ".abacusai-bot");
    process.env.ABACUSAI_BOT_BASE = base;
    seed(base);

    await expect(eraseUserData([path.parse(sandbox).root])).rejects.toThrow(
      /legacy data directory/
    );
    expect(fs.existsSync(base)).toBe(true);
    // And schedules nothing: a marker here would have the next launch
    // perform the delete that was just refused.
    expect(fs.existsSync(pendingEraseMarkerPath())).toBe(false);
  });

  it("leaves no pending marker when everything went", async () => {
    const home = path.join(sandbox, ".abacusai-bot");
    process.env.ABACUSAI_BOT_HOME = home;
    seed(home);

    await eraseUserData();

    expect(fs.existsSync(pendingEraseMarkerPath())).toBe(false);
  });

  // The Windows case, simulated with permissions — POSIX unlinks open files,
  // and chmod binds neither root nor Windows.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "hands what it cannot delete to the next launch",
    async () => {
      const home = path.join(sandbox, ".abacusai-bot");
      process.env.ABACUSAI_BOT_HOME = home;
      seed(home);
      const locked = path.join(home, "locked");
      fs.mkdirSync(locked);
      fs.writeFileSync(path.join(locked, "held-open"), "x");
      fs.chmodSync(locked, 0o500);

      try {
        await eraseUserData();
        expect(fs.existsSync(pendingEraseMarkerPath())).toBe(true);

        fs.chmodSync(locked, 0o700);
        finishPendingErase();
        expect(fs.existsSync(home)).toBe(false);
        expect(fs.existsSync(pendingEraseMarkerPath())).toBe(false);
      } finally {
        if (fs.existsSync(locked)) fs.chmodSync(locked, 0o700);
      }
    }
  );
});

describe("finishing a pending erase at launch", () => {
  it("does nothing without a marker", () => {
    const home = path.join(sandbox, ".abacusai-bot");
    process.env.ABACUSAI_BOT_HOME = home;
    seed(home);

    finishPendingErase();

    expect(fs.existsSync(path.join(home, "config.json"))).toBe(true);
  });

  it("erases the base and legacy directories and clears the marker", () => {
    const base = path.join(sandbox, ".abacusai-bot");
    const legacy = path.join(sandbox, "Library", "Application Support", "Bot");
    process.env.ABACUSAI_BOT_BASE = base;
    seed(base);
    seed(legacy);
    fs.writeFileSync(pendingEraseMarkerPath(), "");

    finishPendingErase([legacy]);

    expect(fs.existsSync(base)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(pendingEraseMarkerPath())).toBe(false);
  });

  it("skips an unsafe directory and keeps the marker rather than throwing", () => {
    const base = path.join(sandbox, ".abacusai-bot");
    process.env.ABACUSAI_BOT_BASE = base;
    seed(base);
    fs.writeFileSync(pendingEraseMarkerPath(), "");

    finishPendingErase([path.parse(sandbox).root]);

    expect(fs.existsSync(base)).toBe(false);
    expect(fs.existsSync(pendingEraseMarkerPath())).toBe(true);
  });
});
