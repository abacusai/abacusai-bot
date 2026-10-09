import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseAst } from "rolldown/parseAst";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ isPackaged: false, getPath: vi.fn() }));
vi.mock("electron", () => ({ app: native }));
let scratch: string;
let base: string;
let browser: string;
let legacy: string;
beforeEach(() => {
  vi.resetModules();
  native.isPackaged = false;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reset-startup-"));
  base = path.join(scratch, "profile");
  browser = path.join(scratch, "browser");
  legacy = path.join(scratch, "real-installation-browser");
  for (const dir of [base, browser, legacy]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "secret"), "private");
  }
  fs.writeFileSync(
    path.join(base, "profiles.json"),
    JSON.stringify({ active: "old", profiles: { old: "profiles/old" } })
  );
  fs.writeFileSync(
    `${base}.delete-pending`,
    JSON.stringify({ ownerPid: 123456 })
  );
  vi.stubEnv("ABACUSAI_BOT_BASE", base);
  vi.stubEnv("ABACUSAI_BOT_HOME", path.join(base, "profiles/old"));
  vi.stubEnv("ABACUSAI_BOT_USERDATA", browser);
  native.getPath.mockReturnValue(legacy);
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("exited"), { code: "ESRCH" });
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(scratch, { recursive: true, force: true });
});

it("erases an isolated installation before selecting a profile, without touching real Chromium data", async () => {
  const read = fs.readFileSync;
  let selectedAfterErase = false;
  vi.spyOn(fs, "readFileSync").mockImplementation(((
    file: fs.PathOrFileDescriptor,
    options: never
  ) => {
    if (file === path.join(base, "profiles.json"))
      selectedAfterErase =
        !fs.existsSync(base) &&
        !fs.existsSync(browser) &&
        !fs.existsSync(`${base}.delete-pending`);
    return read(file, options);
  }) as typeof fs.readFileSync);
  await import("../../profile-home-init");
  expect(selectedAfterErase).toBe(true);
  expect(process.env.ABACUSAI_BOT_HOME).toBe(base);
  expect(fs.readFileSync(path.join(legacy, "secret"), "utf8")).toBe("private");
});

it("blocks profile initialization on locked files, then finishes on a later launch", async () => {
  const remove = fs.rmSync;
  const lock = vi.spyOn(fs, "rmSync").mockImplementation((file, options) => {
    if (file === base)
      throw Object.assign(new Error("Windows file is locked"), {
        code: "EBUSY",
      });
    return remove(file, options);
  });
  await expect(import("../../profile-home-init")).rejects.toThrow(
    "Windows file is locked"
  );
  expect(process.env.ABACUSAI_BOT_HOME).toBe(path.join(base, "profiles/old"));
  expect(fs.existsSync(`${base}.delete-pending`)).toBe(true);
  lock.mockRestore();
  vi.resetModules();
  await import("../../profile-home-init");
  expect(fs.existsSync(base)).toBe(false);
  expect(fs.existsSync(browser)).toBe(false);
  expect(process.env.ABACUSAI_BOT_HOME).toBe(base);
});

it("keeps profile initialization as index's first local side-effect import", () => {
  const source = fs.readFileSync(
    new URL("../../index.ts", import.meta.url),
    "utf8"
  );
  const ast = parseAst(source, { lang: "ts" }) as {
    body: Array<{
      type: string;
      source?: { value: string };
      specifiers?: unknown[];
    }>;
  };
  const firstLocal = ast.body.find(
    (node) =>
      node.type === "ImportDeclaration" && node.source?.value.startsWith("./")
  );
  expect(firstLocal?.source?.value).toBe("./profile-home-init");
  expect(firstLocal?.specifiers).toEqual([]);
});

for (const packaged of [false, true]) {
  it(`preserves shared Electron data in development and clears app-owned packaged data (${packaged})`, async () => {
    fs.rmSync(`${base}.delete-pending`);
    base = path.join(scratch, ".abacusai-bot");
    fs.mkdirSync(base);
    fs.writeFileSync(path.join(base, "secret"), "private");
    fs.writeFileSync(
      `${base}.delete-pending`,
      JSON.stringify({ ownerPid: 123456 })
    );
    vi.spyOn(os, "homedir").mockReturnValue(scratch);
    vi.stubEnv("ABACUSAI_BOT_BASE", base);
    vi.stubEnv("ABACUSAI_BOT_HOME", base);
    vi.stubEnv("ABACUSAI_BOT_USERDATA", "");
    native.isPackaged = packaged;
    await import("../../profile-home-init");
    expect(fs.existsSync(base)).toBe(false);
    expect(fs.existsSync(legacy)).toBe(!packaged);
  });
}
