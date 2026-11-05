import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { routineModels } from "./009-routine-models";

let root: string;
const ctx = () => ({
  home: root,
  userData: root,
  appVersion: "test",
  staging: path.join(root, "staging"),
  progress: () => {},
  log: () => {},
});
const write = (file: string, value: unknown) =>
  fs.writeFileSync(path.join(root, file), JSON.stringify(value));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "routine-models-"));
  fs.mkdirSync(path.join(root, "staging"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it("stamps each routine with what it runs on now, once", async () => {
  write("config.json", { defaultModel: "a/picked" });
  write("bots.json", [
    { id: "pinned", model: "b/bot" },
    { id: "default", model: null },
  ]);
  const unreadable = { note: "not a job" };
  write("cronjobs.json", [
    { id: "plain", prompt: "p", botId: null },
    { id: "bot", prompt: "p", botId: "pinned" },
    { id: "bot-on-default", prompt: "p", botId: "default" },
    { id: "gone-bot", prompt: "p", botId: "deleted" },
    { id: "set", prompt: "p", botId: "pinned", model: "c/own" },
    { id: "follows", prompt: "p", botId: "pinned", model: null },
    unreadable,
  ]);
  const plan = await routineModels().plan(ctx());
  expect(plan.stats).toMatchObject({ routines: 7, stamped: 4 });
  expect(plan.writes).toHaveLength(1);
  expect(plan.writes[0].kind).toBe("replace-user");
  fs.copyFileSync(plan.writes[0].staged, plan.writes[0].dest);
  const jobs = JSON.parse(
    fs.readFileSync(path.join(root, "cronjobs.json"), "utf8")
  ) as Array<{ id?: string; model?: string | null }>;
  expect(jobs.map((job) => [job.id, job.model])).toEqual([
    ["plain", "a/picked"],
    ["bot", "b/bot"],
    ["bot-on-default", "a/picked"],
    ["gone-bot", "a/picked"],
    ["set", "c/own"],
    ["follows", null],
    [undefined, undefined],
  ]);
  expect((await routineModels().plan(ctx())).writes).toEqual([]);
});

it("leaves a routine with no default and no bot model on the app default", async () => {
  write("cronjobs.json", [{ id: "plain", prompt: "p", botId: null }]);
  const plan = await routineModels().plan(ctx());
  fs.copyFileSync(plan.writes[0].staged, plan.writes[0].dest);
  const [job] = JSON.parse(
    fs.readFileSync(path.join(root, "cronjobs.json"), "utf8")
  ) as Array<{ model?: string | null }>;
  expect(job.model).toBeNull();
});

it("writes nothing without routines, and leaves an unreadable file alone", async () => {
  expect((await routineModels().plan(ctx())).writes).toEqual([]);
  fs.writeFileSync(path.join(root, "cronjobs.json"), "{torn");
  expect((await routineModels().plan(ctx())).writes).toEqual([]);
});
