import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  finishPendingErase,
  pendingEraseMarkerPath,
  requestDataReset,
} from "./delete-all-data";

let scratch: string;
let home: string;
const write = (name: string, value = "private") => {
  const file = path.join(home, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
};
const exited = () =>
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("exited"), { code: "ESRCH" });
  });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "delete-data-test-"));
  home = path.join(scratch, "app");
  vi.stubEnv("ABACUSAI_BOT_BASE", home);
  vi.stubEnv("ABACUSAI_BOT_HOME", path.join(home, "profiles", "second"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(scratch, { recursive: true, force: true });
});

it("waits for graceful quit, then removes all profiles and browser data without following workspace links", async () => {
  for (const file of [
    "config.json",
    "profiles/second/config.json",
    "threads/chat.json",
    "routines.json",
    "memory/m.md",
    "skills/tool/SKILL.md",
    "models/model.bin",
    "bot-home/draft.txt",
    "session-home/output.txt",
    "electron/Cookies",
  ])
    write(file);
  const project = path.join(scratch, "project");
  fs.mkdirSync(path.join(project, ".abacusai-bot"), { recursive: true });
  fs.writeFileSync(path.join(project, ".abacusai-bot/plan.md"), "keep");
  fs.symlinkSync(
    project,
    path.join(home, "workspace-link"),
    process.platform === "win32" ? "junction" : "dir"
  );
  const browser = path.join(scratch, "isolated-browser");
  fs.mkdirSync(browser);
  fs.writeFileSync(path.join(browser, "Cookies"), "private");
  const order: string[] = [];
  const lifecycle = {
    relaunch: () => order.push("relaunch"),
    quit: () => order.push("quit: close agents, PTYs and browser"),
  };
  requestDataReset(lifecycle, [browser]);
  expect(fs.existsSync(path.join(home, "config.json"))).toBe(true);
  expect(order).toEqual(["relaunch"]);
  await turn();
  expect(order).toEqual(["relaunch", "quit: close agents, PTYs and browser"]);
  expect(() => finishPendingErase([browser])).toThrow(
    "previous AbacusAI Bot instance"
  );
  expect(fs.existsSync(home)).toBe(true);
  exited();
  finishPendingErase([browser]);
  expect(fs.existsSync(home)).toBe(false);
  expect(fs.existsSync(browser)).toBe(false);
  expect(fs.existsSync(pendingEraseMarkerPath())).toBe(false);
  expect(
    fs.readFileSync(path.join(project, ".abacusai-bot/plan.md"), "utf8")
  ).toBe("keep");
});

it("leaves data alone without a confirmed pending reset", () => {
  write("config.json");
  finishPendingErase();
  expect(fs.readFileSync(path.join(home, "config.json"), "utf8")).toBe(
    "private"
  );
});

it.each(["root", "home", "cwd", "temp", "symlink"])(
  "refuses unsafe %s targets before arming or deleting",
  (kind) => {
    write("config.json");
    const bad =
      kind === "root"
        ? path.parse(home).root
        : kind === "home"
          ? os.homedir()
          : kind === "cwd"
            ? process.cwd()
            : kind === "temp"
              ? os.tmpdir()
              : path.join(scratch, "linked");
    if (kind === "symlink")
      fs.symlinkSync(
        home,
        bad,
        process.platform === "win32" ? "junction" : "dir"
      );
    const lifecycle = { relaunch: vi.fn(), quit: vi.fn() };
    expect(() => requestDataReset(lifecycle, [bad])).toThrow("Refusing");
    expect(lifecycle.relaunch).not.toHaveBeenCalled();
    expect(fs.existsSync(pendingEraseMarkerPath())).toBe(false);
    expect(fs.existsSync(home)).toBe(true);
  }
);

it("retains the marker when Windows keeps a file locked and retries before opening stores", async () => {
  write("electron/Cookies");
  requestDataReset({ relaunch() {}, quit() {} });
  await turn();
  exited();
  const rm = fs.rmSync;
  const remove = vi.spyOn(fs, "rmSync").mockImplementation((file, options) => {
    if (file === home)
      throw Object.assign(new Error("locked"), { code: "EBUSY" });
    return rm(file, options);
  });
  expect(() => finishPendingErase()).toThrow("locked");
  expect(remove).toHaveBeenCalledWith(home, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 150,
  });
  expect(fs.existsSync(pendingEraseMarkerPath())).toBe(true);
  remove.mockRestore();
  finishPendingErase();
  expect(fs.existsSync(home)).toBe(false);
  expect(fs.existsSync(pendingEraseMarkerPath())).toBe(false);
});

it("rolls back a failed relaunch and allows a fresh confirmed retry", async () => {
  write("config.json");
  const quit = vi.fn();
  expect(() =>
    requestDataReset({
      relaunch() {
        throw new Error("relaunch failed");
      },
      quit,
    })
  ).toThrow("relaunch failed");
  expect(fs.existsSync(pendingEraseMarkerPath())).toBe(false);
  expect(quit).not.toHaveBeenCalled();
  requestDataReset({ relaunch() {}, quit });
  await turn();
  expect(quit).toHaveBeenCalledOnce();
  expect(fs.existsSync(home)).toBe(true);
});

it("does not schedule duplicate relaunches for repeated confirmed requests", async () => {
  write("config.json");
  const lifecycle = { relaunch: vi.fn(), quit: vi.fn() };
  requestDataReset(lifecycle);
  requestDataReset(lifecycle);
  await turn();
  expect(lifecycle.relaunch).toHaveBeenCalledOnce();
  expect(lifecycle.quit).toHaveBeenCalledOnce();
});
