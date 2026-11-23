import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { routineGithubOn } from "./011-routine-github-on";

let root: string;
const ctx = () => ({
  home: root,
  userData: root,
  appVersion: "test",
  staging: path.join(root, "staging"),
  progress: () => {},
  log: () => {},
});
const cronjobs = () => path.join(root, "cronjobs.json");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "routine-github-on-"));
  fs.mkdirSync(path.join(root, "staging"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it("turns a review routine's flag into the kinds it runs on, once", async () => {
  const unreadable = { note: "not a job" };
  fs.writeFileSync(
    cronjobs(),
    JSON.stringify([
      { id: "review", prompt: "p", githubReviews: true },
      { id: "off", prompt: "p", githubReviews: false },
      { id: "plain", prompt: "p" },
      { id: "new", prompt: "p", githubOn: ["pr", "ci"] },
      unreadable,
    ])
  );
  const plan = await routineGithubOn().plan(ctx());
  expect(plan.stats).toMatchObject({ routines: 5, moved: 2 });
  expect(plan.writes[0]?.kind).toBe("replace-user");
  fs.copyFileSync(plan.writes[0]!.staged, plan.writes[0]!.dest);
  expect(JSON.parse(fs.readFileSync(cronjobs(), "utf8"))).toEqual([
    { id: "review", prompt: "p", githubOn: ["review"] },
    { id: "off", prompt: "p" },
    { id: "plain", prompt: "p" },
    { id: "new", prompt: "p", githubOn: ["pr", "ci"] },
    unreadable,
  ]);
  expect((await routineGithubOn().plan(ctx())).writes).toEqual([]);
});

it("writes nothing without routines, and leaves an unreadable file alone", async () => {
  expect((await routineGithubOn().plan(ctx())).writes).toEqual([]);
  fs.writeFileSync(cronjobs(), "{torn");
  expect((await routineGithubOn().plan(ctx())).writes).toEqual([]);
});
