import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  botDir,
  botForSession,
  botSessionIds,
  createBot,
  getBot,
  listBots,
  personaPath,
  recordBotSession,
  removeBot,
  updateBot,
} from "./bot-store";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-bots-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;

  fs.rmSync(home, { recursive: true, force: true });
});

describe("creating a bot", () => {
  it("persists it with defaults filled in", () => {
    const bot = createBot({ name: "Scout", description: "Watch the news." });

    expect(listBots()).toHaveLength(1);
    expect(getBot(bot.id)?.name).toBe("Scout");
    expect(bot.sessionId).toBeNull();
    expect(bot.avatarColor).toMatch(/^#/);
  });

  it("refuses an empty name or mission", () => {
    expect(() => createBot({ name: "  ", description: "x" })).toThrow();
    expect(() => createBot({ name: "Scout", description: " " })).toThrow();
  });

  it("gives the same name the same color every time", () => {
    const first = createBot({ name: "Scout", description: "a" });
    const second = createBot({ name: "Scout", description: "b" });

    expect(first.avatarColor).toBe(second.avatarColor);
  });
});

describe("legacy records", () => {
  it("drops a stored connector grant on read — bots are unrestricted now", () => {
    const bot = createBot({ name: "Old", description: "x" });
    const file = path.join(home, "bots.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >[];
    raw[0].connectorIds = ["abacus-gmailuser"];
    fs.writeFileSync(file, JSON.stringify(raw));

    expect(
      (getBot(bot.id) as unknown as Record<string, unknown>).connectorIds
    ).toBeUndefined();
  });

  it("reads a bot written before voices as one with no voice", () => {
    const bot = createBot({ name: "Old", description: "x" });
    const file = path.join(home, "bots.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >[];
    delete raw[0].persona;
    fs.writeFileSync(file, JSON.stringify(raw));

    expect(getBot(bot.id)?.persona).toBe("");
  });
});

describe("a bot's voice", () => {
  it("is kept apart from the mission, trimmed, and editable", () => {
    const bot = createBot({
      name: "Buddy",
      description: "Track my topics.",
      persona: "  dry wit, calls me boss  ",
    });
    expect(bot.persona).toBe("dry wit, calls me boss");
    expect(bot.description).toBe("Track my topics.");

    expect(updateBot(bot.id, { persona: "" }).persona).toBe("");
  });
});

describe("updating a bot", () => {
  it("merges changes and refuses to blank the identity", () => {
    const bot = createBot({ name: "Scout", description: "Watch the news." });

    const updated = updateBot(bot.id, { title: "Research Scout" });

    expect(updated.title).toBe("Research Scout");
    expect(updated.description).toBe("Watch the news.");
    expect(() => updateBot(bot.id, { name: "" })).toThrow();
  });
});

describe("the forever chat pointer", () => {
  it("round-trips through recordBotSession and the session lookups", () => {
    const bot = createBot({ name: "Scout", description: "Watch the news." });

    recordBotSession(bot.id, "ws-1", "session-1");

    expect(botForSession("session-1")?.id).toBe(bot.id);
    expect(botSessionIds()).toEqual(["session-1"]);
    expect(botForSession("session-2")).toBeNull();
  });
});

describe("removing a bot", () => {
  it("drops the record and its directory", () => {
    const bot = createBot({ name: "Scout", description: "Watch the news." });
    fs.mkdirSync(botDir(bot.id), { recursive: true });
    fs.writeFileSync(personaPath(bot.id), "persona\n");

    removeBot(bot.id);

    expect(listBots()).toEqual([]);
    expect(fs.existsSync(botDir(bot.id))).toBe(false);
    expect(() => removeBot(bot.id)).toThrow();
  });
});
