/**
 * The Memory page's writes against a real memory folder under a temp
 * `ABACUSAI_BOT_HOME`: save and edit, the card kept a card, clear, the
 * history the page shows, and undo.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureProject } from "@abacus-ai/agent/memory";
import { ConflictError } from "@abacus-ai/contract/conflict";
import { InvalidInputError } from "@abacus-ai/contract/service-errors";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  chatProject,
  clearMemory,
  forgetNote,
  memoryHistory,
  memoryProjects,
  memoryRows,
  noteToBotJournal,
  saveNote,
  undoChange,
} from "./memory-service";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "memory-service-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const shop = () =>
  ensureProject({
    kind: "folder",
    key: "/work/shop",
    name: "Shop",
    path: "/work/shop",
  });

describe("saving from the page", () => {
  it("creates a note, then updates it by name with a fresh description", async () => {
    const row = await saveNote({
      scope: "you",
      type: "rule",
      text: "Reply in short sentences.",
    });
    expect(row).toMatchObject({
      id: "you/reply-in-short-sentences.md",
      scope: "you",
      project: null,
      type: "rule",
      body: "Reply in short sentences.",
      by: "you",
    });
    const edited = await saveNote({
      scope: "you",
      name: row.name,
      type: "rule",
      text: "Reply in one paragraph at most.",
    });
    expect(edited).toMatchObject({
      id: row.id,
      description: "Reply in one paragraph at most.",
    });
    expect(memoryRows()).toHaveLength(1);
  });

  it("refuses what the gate refuses, with its reason", async () => {
    const secret = ["sk", "-", "a1b2c3d4e5f6g7h8i9j0k1l2"].join("");
    await expect(
      saveNote({ scope: "you", type: "fact", text: `My key is ${secret}` })
    ).rejects.toThrow(InvalidInputError);
    await expect(
      saveNote({ scope: "you", type: "fact", text: "  " })
    ).rejects.toThrow(/empty/);
    expect(memoryRows()).toEqual([]);
  });

  it("edits a project's card in place, keeping its binding; a card is never created or forgotten", async () => {
    const project = (await shop())!;
    await saveNote({
      scope: "project",
      project: project.slug,
      name: "project",
      type: "card",
      text: "What: Shop\nGoal: launch in March",
    });
    expect(memoryProjects()).toEqual([
      {
        slug: project.slug,
        name: "Shop",
        kind: "folder",
        key: "/work/shop",
        path: "/work/shop",
      },
    ]);
    const card = memoryRows().find((row) => row.type === "card")!;
    expect(card.body).toContain("launch in March");
    await expect(
      saveNote({
        scope: "project",
        project: project.slug,
        type: "card",
        text: "x",
      })
    ).rejects.toThrow(InvalidInputError);
    await expect(forgetNote(card.id)).rejects.toThrow(InvalidInputError);
  });

  it("refuses an id outside the memory folder or not a note", async () => {
    await expect(forgetNote("you/../../prefs.json")).rejects.toThrow(
      InvalidInputError
    );
    await expect(
      forgetNote("projects/shop/journal/2026-11.md")
    ).rejects.toThrow(InvalidInputError);
  });
});

describe("clear", () => {
  it("forgets a project's notes and resets its card", async () => {
    const project = (await shop())!;
    const scope = { scope: "project" as const, project: project.slug };
    await saveNote({
      ...scope,
      name: "project",
      type: "card",
      text: "What: Shop\nStatus: late",
    });
    await saveNote({
      ...scope,
      type: "decision",
      text: "Ship on Fridays only.",
    });
    await saveNote({ scope: "you", type: "rule", text: "Never use emoji." });
    await clearMemory(scope);
    const rows = memoryRows();
    expect(rows.map((row) => row.type).sort()).toEqual(["card", "rule"]);
    expect(rows.find((row) => row.type === "card")!.body).not.toContain("late");
    expect(memoryProjects()).toHaveLength(1);
  });
});

describe("history and undo", () => {
  it("lists changes newest first and undoes one while the file is as it left it", async () => {
    const row = await saveNote({
      scope: "you",
      type: "fact",
      text: "Lives in Oslo.",
    });
    await saveNote({
      scope: "you",
      name: row.name,
      type: "fact",
      text: "Lives in Bergen.",
    });
    const [changed, saved] = memoryHistory();
    expect(changed).toMatchObject({
      action: "changed",
      by: "you",
      scope: "you",
      name: row.name,
      undoable: true,
    });
    expect(saved).toMatchObject({
      action: "saved",
      summary: "Lives in Oslo.",
      undoable: false,
    });

    // The older change cannot be undone over the newer one.
    await expect(undoChange(saved!.id)).rejects.toThrow(ConflictError);
    await undoChange(changed!.id);
    expect(memoryRows()[0]!.body).toBe("Lives in Oslo.");
    // The undo is itself a change in the history.
    expect(memoryHistory()[0]).toMatchObject({ action: "changed", by: "you" });
  });

  it("brings a forgotten note back", async () => {
    const row = await saveNote({
      scope: "you",
      type: "preference",
      text: "Likes tea.",
    });
    await forgetNote(row.id);
    expect(memoryRows()).toEqual([]);
    const [forgot] = memoryHistory();
    expect(forgot).toMatchObject({
      action: "forgot",
      summary: "Likes tea.",
      undoable: true,
    });
    await undoChange(forgot!.id);
    expect(memoryRows().map((each) => each.body)).toEqual(["Likes tea."]);
  });

  it("shows a bot's journal line as noted, in the bot's project", async () => {
    await noteToBotJournal(
      { id: "bot-ada", name: "Ada" },
      "Drafted the newsletter for Bea."
    );
    const [noted] = memoryHistory();
    expect(noted).toMatchObject({
      action: "noted",
      by: "app",
      scope: "project",
      name: null,
      summary: "Drafted the newsletter for Bea.",
    });
    expect(memoryProjects()).toMatchObject([
      { kind: "bot", key: "bot-ada", name: "Ada" },
    ]);
  });

  it("refuses an undo of a change no longer in the history", async () => {
    await expect(
      undoChange("2020-01-01T00:00:00.000Z|you/gone.md")
    ).rejects.toThrow(ConflictError);
    await expect(
      undoChange("2020-01-01T00:00:00.000Z|../outside.md")
    ).rejects.toThrow(InvalidInputError);
  });
});

describe("a chat's project", () => {
  it("is the declared one, else the one the chat opened, else none", async () => {
    const project = (await shop())!;
    expect(chatProject("/work/shop", "s1")).toMatchObject({
      slug: project.slug,
    });
    expect(chatProject(null, "s1")).toBeNull();
    fs.writeFileSync(
      path.join(home, "memory", ".chats.json"),
      JSON.stringify({ s1: "/work/shop" })
    );
    expect(chatProject(null, "s1")).toMatchObject({
      name: "Shop",
      kind: "folder",
    });
    expect(chatProject("/nowhere", "s1")).toBeNull();
  });
});
