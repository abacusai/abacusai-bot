/**
 * The memory folder end to end on real files: the tool writes through the
 * checks, the prompt block shows each chat only its own scopes, another chat's
 * change arrives as news, and the old stores move in once.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { memoryBlock, memoryNews } from "./core.js";
import { type Lane, readMemoryContext } from "./lanes.js";
import { migrateOnce, readMigrationReport } from "./migrate.js";
import {
  historyCursor,
  listNotes,
  listProjects,
  readJournal,
  readNote,
  recentHistory,
} from "./notes.js";
import { recallFor } from "./recall.js";
import { buildMemoryTool } from "./tool.js";

let home: string;
const previous = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "memory-v3-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previous == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previous;
  fs.rmSync(home, { recursive: true, force: true });
});

const SHOP = {
  kind: "folder",
  key: "/work/shop",
  name: "shop",
  path: "/work/shop",
};

const chat = (lane: Lane, extra: Record<string, string> = {}, words = "") => {
  const context = readMemoryContext("/work/shop", "default", {
    ABACUSAI_BOT_MEMORY: lane,
    ABACUSAI_BOT_MEMORY_PROJECT: JSON.stringify(SHOP),
    ...extra,
  });
  let saved = 0;
  const tool = buildMemoryTool(context, {
    userWords: () => words,
    model: () => "test/model",
    saved: () => {
      saved += 1;
    },
  });
  const call = async (params: Record<string, unknown>) => {
    const result = await tool!.execute("id", params);
    return { text: result.content[0]!.text, error: result.isError === true };
  };
  return { context, call, saved: () => saved };
};

describe("the memory tool", () => {
  it("saves, updates, reads, searches and forgets, recording each change", async () => {
    const { call, saved } = chat("owner");

    const first = await call({
      action: "save",
      type: "preference",
      text: "Prefers short replies with no emoji.",
      name: "short-replies",
    });
    expect(first).toMatchObject({ error: false });
    expect(readNote({ kind: "you" }, "short-replies")?.by).toBe("chat");

    const fact = await call({
      action: "save",
      type: "fact",
      text: "The shop ships to Portugal and Spain only.",
      name: "shipping",
    });
    expect(fact.text).toContain("in project shop");

    await call({
      action: "update",
      name: "shipping",
      text: "The shop ships to Portugal, Spain and France.",
    });
    expect((await call({ action: "read", name: "shipping" })).text).toContain(
      "France"
    );
    expect(
      (await call({ action: "search", query: "ships france" })).text
    ).toContain("shipping");

    await call({ action: "forget", name: "short-replies" });
    expect(readNote({ kind: "you" }, "short-replies")).toBeNull();
    expect(saved()).toBe(4);
    expect(recentHistory().length).toBeGreaterThanOrEqual(4);
  });

  it("refuses what the gate refuses and saves nothing", async () => {
    const { call, saved } = chat("owner");
    const result = await call({
      action: "save",
      text: "config.yaml does not exist in the bot folder",
    });
    expect(result.error).toBe(true);
    expect(saved()).toBe(0);
    expect(listNotes({ kind: "you" })).toEqual([]);
  });

  it("keeps the card's binding when the card is updated", async () => {
    const { call } = chat("owner");
    await call({
      action: "update",
      name: "project",
      text: "What: online shop\nGoal: 100 orders a month\nStatus: launching",
    });
    expect(listProjects()[0]).toMatchObject({
      key: "/work/shop",
      kind: "folder",
    });
    expect(
      readNote({ kind: "project", slug: "shop" }, "project")?.body
    ).toContain("100 orders");
  });

  it("removes the note a new one replaces", async () => {
    const { call } = chat("owner");
    await call({
      action: "save",
      type: "fact",
      text: "Deploy script is at scripts/old-deploy.sh",
      name: "deploy-script",
    });
    await call({
      action: "save",
      type: "fact",
      text: "Deploys run from the CI pipeline now",
      name: "deploys-in-ci",
      replaces: "deploy-script",
    });
    const names = listNotes({ kind: "project", slug: "shop" }).map(
      (note) => note.name
    );
    expect(names).toContain("deploys-in-ci");
    expect(names).not.toContain("deploy-script");
  });

  it("lets a routine run only add journal lines when nobody watches", async () => {
    const context = readMemoryContext("/work/shop", "UNATTENDED", {
      ABACUSAI_BOT_MEMORY: "routine",
      ABACUSAI_BOT_MEMORY_PROJECT: JSON.stringify(SHOP),
    });
    const tool = buildMemoryTool(context, {
      userWords: () => "",
      model: () => undefined,
      saved: () => {},
    })!;
    const save = await tool.execute("1", {
      action: "save",
      text: "Orders spike on Fridays.",
    });
    expect(save.isError).toBe(true);
    await tool.execute("2", {
      action: "note",
      text: "Sent the Friday digest.",
    });
    expect(readJournal({ kind: "project", slug: "shop" })[0]).toContain(
      "Friday digest"
    );
  });

  it("keeps a sender's notes in their own folder, away from the user", async () => {
    const sender = chat("bot-sender", {
      ABACUSAI_BOT_MEMORY_CONTACT: "lead-1",
    });
    const saved = await sender.call({
      action: "save",
      type: "fact",
      text: "Asking about the weekend batch class.",
      about: "you",
    });
    expect(saved.text).toContain("about this person");
    expect(listNotes({ kind: "you" })).toEqual([]);
    expect(
      listNotes({ kind: "contact", slug: "shop", contact: "lead-1" })
    ).toHaveLength(1);
  });

  it("has no tool when memory is off or the chat is a stranger's", () => {
    for (const lane of ["off", "sender"] as const) {
      const context = readMemoryContext("/work/shop", "default", {
        ABACUSAI_BOT_MEMORY: lane,
      });
      expect(
        buildMemoryTool(context, {
          userWords: () => "",
          model: () => undefined,
          saved: () => {},
        })
      ).toBeNull();
    }
  });
});

describe("the memory block", () => {
  it("shows rules whole, other notes as dated lines, and the project card", async () => {
    const { call, context } = chat("owner");
    await call({
      action: "save",
      type: "rule",
      text: "Never send anything to clients without asking first.",
    });
    await call({
      action: "save",
      type: "fact",
      text: "Has a sister in Goa who visits every December.",
      about: "you",
    });
    await call({
      action: "update",
      name: "project",
      text: "What: online shop\nStatus: launching",
    });

    const block = (await memoryBlock(context))!;
    expect(block).toContain(
      "Never send anything to clients without asking first."
    );
    expect(block).toMatch(/- has-a-sister-in-goa-who: .* \(fact, today\)/);
    expect(block).toContain("Status: launching");
  });

  it("gives a run nobody watches the project only, and a stranger nothing of the user", async () => {
    const owner = chat("owner");
    await owner.call({
      action: "save",
      type: "rule",
      text: "Call me Sam, never Samuel.",
    });

    const unattended = readMemoryContext("/work/shop", "UNATTENDED", {
      ABACUSAI_BOT_MEMORY: "routine",
      ABACUSAI_BOT_MEMORY_PROJECT: JSON.stringify(SHOP),
    });
    expect(await memoryBlock(unattended)).not.toContain("Call me Sam");

    const sender = readMemoryContext("/work/shop", "default", {
      ABACUSAI_BOT_MEMORY: "bot-sender",
      ABACUSAI_BOT_MEMORY_PROJECT: JSON.stringify(SHOP),
      ABACUSAI_BOT_MEMORY_CONTACT: "lead-1",
    });
    const block = (await memoryBlock(sender))!;
    expect(block).not.toContain("Call me Sam");
    expect(block).toContain("About the person you are talking with");

    const off = readMemoryContext("/work/shop", "default", {
      ABACUSAI_BOT_MEMORY: "off",
    });
    expect(await memoryBlock(off)).toBeNull();
  });

  it("drops expired status notes when a chat starts", async () => {
    const { call, context } = chat("owner");
    await call({
      action: "save",
      type: "status",
      text: "Waiting on the printer quote",
      expires: "2026-11-15",
    });
    const later = new Date("2026-11-20T00:00:00Z");
    const block = (await memoryBlock(context, later))!;
    expect(block).not.toContain("printer");
    expect(
      listNotes({ kind: "project", slug: "shop" }).some(
        (note) => note.type === "status"
      )
    ).toBe(false);
  });
});

describe("news between chats", () => {
  it("tells a running chat what another chat changed, never its own changes", async () => {
    const { context, call } = chat("owner");
    await memoryBlock(context);
    const cursor = historyCursor();
    await call({ action: "save", type: "rule", text: "Sign emails as Sam." });
    // Same process, same session id: its own change is not news to it.
    expect(
      memoryNews(
        context,
        cursor,
        process.env.ABACUSAI_BOT_SESSION_ID ?? `pid-${process.pid}`
      ).text
    ).toBe("");
    const other = memoryNews(context, cursor, "another-chat");
    expect(other.text).toContain("Sign emails as Sam.");
  });
});

describe("moving the old stores in", () => {
  it("moves each entry once, leaves the old files, and withholds secrets", async () => {
    const memories = path.join(home, "memories");
    fs.mkdirSync(memories, { recursive: true });
    fs.writeFileSync(
      path.join(memories, "REMEMBER.md"),
      "Always answer in British English\n§\nThe shop PIN: 4821"
    );
    fs.writeFileSync(
      path.join(memories, "USER.md"),
      "Runs a small bakery in Pune"
    );
    fs.writeFileSync(
      path.join(memories, "MEMORY.md"),
      "Uses Shopify for the store"
    );
    const bot = path.join(home, "bots", "b1");
    fs.mkdirSync(path.join(bot, "memory"), { recursive: true });
    fs.writeFileSync(
      path.join(bot, "MEMORY.md"),
      "- Leads come from Instagram\n"
    );
    fs.writeFileSync(
      path.join(bot, "memory", "2026-10-02.md"),
      "- replied to a lead about prices\n"
    );

    await migrateOnce((id) => (id === "b1" ? "Front desk" : id));
    await migrateOnce();

    const you = listNotes({ kind: "you" });
    expect(you.map((note) => note.body).sort()).toEqual([
      "Always answer in British English",
      "Runs a small bakery in Pune",
      "Uses Shopify for the store",
    ]);
    expect(you.find((note) => note.body.startsWith("Always"))?.type).toBe(
      "rule"
    );
    expect(readMigrationReport()?.withheld).toHaveLength(1);
    expect(fs.existsSync(path.join(memories, "REMEMBER.md"))).toBe(true);

    const project = listProjects().find((each) => each.key === "b1")!;
    expect(project.name).toBe("Front desk");
    expect(
      listNotes({ kind: "project", slug: project.slug }).map(
        (note) => note.body
      )
    ).toContain("Leads come from Instagram");
    expect(readJournal({ kind: "project", slug: project.slug })[0]).toContain(
      "replied to a lead"
    );
  });
});

describe("recall", () => {
  it("brings notes and journal lines that match the message, and nothing for small talk", async () => {
    const { call, context } = chat("owner");
    await call({
      action: "save",
      type: "fact",
      text: "The courier for Lisbon orders is CTT Expresso, pickup at 4pm.",
      name: "lisbon-courier",
    });
    await call({
      action: "note",
      text: "Refunded order 1182 because the parcel arrived damaged.",
    });
    const slug = listProjects()[0]!.slug;

    expect(
      recallFor(context, slug, "which courier picks up the Lisbon orders?")
    ).toContain("CTT Expresso");
    expect(recallFor(context, slug, "why did we refund order 1182?")).toContain(
      "arrived damaged"
    );
    expect(recallFor(context, slug, "hi, how are you today?")).toBe("");
  });

  it("finds a note by its keywords in another language, and sees a new note at once", async () => {
    const { call, context } = chat("owner");
    await call({
      action: "save",
      type: "decision",
      text: "The venue is the old fort hotel, booked for 14 February.",
      name: "venue",
      keywords: "wedding, hall, शादी, स्थल",
    });
    const slug = listProjects()[0]!.slug;
    expect(recallFor(context, slug, "शादी का स्थल कौन सा है?")).toContain(
      "old fort hotel"
    );
    expect(
      recallFor(context, slug, "who is the caterer for the wedding?")
    ).toBe("");
    await call({
      action: "save",
      type: "fact",
      text: "The caterer for the wedding is Anand Foods.",
      name: "caterer",
    });
    expect(
      recallFor(context, slug, "who is the caterer for the wedding?")
    ).toContain("Anand Foods");
  });

  it("never brings the user's notes into a stranger's chat", async () => {
    const owner = chat("owner");
    await owner.call({
      action: "save",
      type: "fact",
      text: "My sister Priya lives in Goa.",
      about: "you",
    });
    const sender = readMemoryContext("/work/shop", "default", {
      ABACUSAI_BOT_MEMORY: "bot-sender",
      ABACUSAI_BOT_MEMORY_PROJECT: JSON.stringify(SHOP),
      ABACUSAI_BOT_MEMORY_CONTACT: "lead-1",
    });
    expect(recallFor(sender, "shop", "does Priya live in Goa?")).toBe("");
  });
});

describe("opening a project from a general chat", () => {
  it("creates it once, links the chat, and saves project facts there", async () => {
    process.env.ABACUSAI_BOT_SESSION_ID = "chat-1";
    try {
      const context = readMemoryContext(
        path.join(home, "session-home"),
        "default",
        { ABACUSAI_BOT_MEMORY: "owner", ABACUSAI_BOT_SESSION_ID: "chat-1" }
      );
      const tool = buildMemoryTool(context, {
        userWords: () => "",
        model: () => undefined,
        saved: () => {},
      })!;
      const opened = await tool.execute("1", {
        action: "open",
        project: "Wedding planning",
      });
      expect(opened.content[0]!.text).toContain(
        "now works in Wedding planning"
      );
      await tool.execute("2", {
        action: "save",
        type: "decision",
        about: "project",
        text: "Venue is the old fort hotel, booked for 14 Feb.",
      });
      const project = listProjects().find(
        (each) => each.name === "Wedding planning"
      )!;
      expect(project.kind).toBe("topic");
      expect(
        listNotes({ kind: "project", slug: project.slug }).some(
          (note) => note.type === "decision"
        )
      ).toBe(true);

      // The next process for the same chat starts in that project.
      const again = readMemoryContext(
        path.join(home, "session-home"),
        "default",
        { ABACUSAI_BOT_MEMORY: "owner", ABACUSAI_BOT_SESSION_ID: "chat-1" }
      );
      expect(again.project?.key).toBe(project.key);
    } finally {
      delete process.env.ABACUSAI_BOT_SESSION_ID;
    }
  });
});
