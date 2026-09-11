/**
 * Connect a connector mid-conversation and the chat must find out.
 *
 * Reported as "is it not aware about connectors?": a GitHub connector was added
 * during a chat, the chat kept answering that it had no GitHub access, and
 * opening a new chat made it work. The environment is described to the model
 * once, when the conversation's prompt is built, so anything connected
 * afterwards was invisible for the rest of that chat.
 *
 * The same report had the other half too: a connector added *before* a chat began,
 * in a chat that then denied having it. So a conversation nobody has told yet
 * is owed the list as well, on its first message.
 *
 * These tests pin both halves: the note itself, and that every way the user has
 * of changing the environment — a messaging connector, an MCP server, a connector
 * (which is an MCP server), a skill — actually raises it.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => os.tmpdir() },
  shell: { openPath: () => {} },
}));

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "env-notice-"));
process.env.ABACUSAI_BOT_HOME = HOME;

// Imported after ABACUSAI_BOT_HOME is set: the config modules resolve their
// directory once, at load.
const {
  EnvironmentNoticeService,
  appendEnvironmentNotice,
  environmentNoticeService,
  formatEnvironmentNotice,
  messageWithEnvironmentNotice,
} = await import("./environment-notice-service");
const { McpConfigService } = await import("../mcp/mcp-config-service");
const messagingConfig = await import("../messaging/messaging-config-service");
const { SkillsService } = await import("../workspace/skills-service");

afterAll(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe("the note itself", () => {
  it("lists what is connected now, in one block, after the user text", () => {
    const notice = formatEnvironmentNotice({
      connectors: ["slack", "whatsapp"],
      accountConnectors: [],
      mcpServers: ["github"],
      skills: ["pdf", "dataviz"],
    });

    expect(notice.startsWith("<system_reminder>")).toBe(true);
    expect(notice.endsWith("</system_reminder>")).toBe(true);
    expect(notice).toContain(
      "Messaging platforms connected (2): slack, whatsapp"
    );
    expect(notice).toContain(
      "MCP servers and connectors configured (1): github"
    );
    expect(notice).toContain("Skills available (2): pdf, dataviz");

    const message = appendEnvironmentNotice(
      "what can you do with github?",
      notice
    );
    expect(message.startsWith("what can you do with github?")).toBe(true);
    expect(message).toContain(notice);
  });

  it("opens differently for a conversation being told for the first time", () => {
    const snapshot = {
      connectors: [],
      accountConnectors: [],
      mcpServers: ["github"],
      skills: [],
    };

    expect(formatEnvironmentNotice(snapshot, "initial")).toContain(
      "This is what you are connected to in this session:"
    );
    expect(formatEnvironmentNotice(snapshot, "update")).toContain(
      "changed after this conversation started"
    );
    // The list itself is the same either way.
    expect(formatEnvironmentNotice(snapshot, "initial")).toContain("github");
    expect(formatEnvironmentNotice(snapshot, "update")).toContain("github");
  });

  /**
   * An attached connector used to appear in no group at all: "Connectors
   * connected" counted messaging platforms, and the only other trace was an
   * MCP server called `abacus-connectors`, which names nothing behind it. So
   * the note said "(0): none" over a live Gmail, and the model had nothing to
   * read that said otherwise — nor who the account belonged to.
   */
  it("names the account connectors, and who each is connected as", () => {
    const notice = formatEnvironmentNotice({
      connectors: [],
      accountConnectors: ["Gmail (gmailuser), as Gmail - ada@example.com"],
      mcpServers: ["abacus-connectors"],
      skills: [],
    });

    expect(notice).toContain(
      "Connectors connected (1): Gmail (gmailuser), as Gmail - ada@example.com"
    );
    // The messaging group no longer answers to the name that misled it.
    expect(notice).toContain("Messaging platforms connected (0): none");
    expect(notice).not.toContain("Connectors connected (0): none");
  });

  it("says none rather than leaving a group blank", () => {
    const notice = formatEnvironmentNotice({
      connectors: [],
      accountConnectors: [],
      mcpServers: [],
      skills: [],
    });
    expect(notice).toContain("Messaging platforms connected (0): none");
    expect(notice).toContain("Connectors connected (0): none");
    expect(notice).toContain("Skills available (0): none");
  });

  it("keeps the note short when a great many skills are installed", () => {
    const skills = Array.from({ length: 60 }, (_, i) => `skill-${i}`);
    const notice = formatEnvironmentNotice({
      connectors: [],
      accountConnectors: [],
      mcpServers: [],
      skills,
    });
    expect(notice).toContain("Skills available (60):");
    expect(notice).toContain("and 20 more");
    expect(notice).not.toContain("skill-59");
  });
});

describe("what the session is actually sent", () => {
  const snapshot = {
    connectors: ["slack"],
    accountConnectors: [],
    mcpServers: ["github"],
    skills: ["pdf"],
  };

  it("leaves a message alone once the conversation has been told", () => {
    const notices = new EnvironmentNoticeService();
    notices.markAnnounced("chat");
    expect(
      messageWithEnvironmentNotice(notices, "chat", "hello", snapshot)
    ).toBe("hello");
  });

  it("states what is connected on a conversation's first message", () => {
    const notices = new EnvironmentNoticeService();
    notices.markSessionStarted("chat");
    const sent = messageWithEnvironmentNotice(
      notices,
      "chat",
      "can you use playwright?",
      snapshot
    );

    expect(sent.startsWith("can you use playwright?")).toBe(true);
    expect(sent).toContain(
      "This is what you are connected to in this session:"
    );
    expect(sent).toContain("MCP servers and connectors configured (1): github");
  });

  it("carries the note behind the user words when something changes later", () => {
    const notices = new EnvironmentNoticeService();
    notices.markAnnounced("chat");
    notices.markChanged();
    const sent = messageWithEnvironmentNotice(
      notices,
      "chat",
      "list my github repos",
      snapshot
    );
    expect(sent.startsWith("list my github repos")).toBe(true);
    expect(sent).toContain("MCP servers and connectors configured (1): github");
  });

  /**
   * The note is a suffix on a fresh message, never an edit to the system
   * prompt: the prompt is the cached prefix every request in the conversation
   * reuses, and rewriting it to add a sentence would throw that cache away.
   */
  it("never touches anything the request already sent", () => {
    const notices = new EnvironmentNoticeService();
    notices.markAnnounced("chat");
    notices.markChanged();
    const sent = messageWithEnvironmentNotice(
      notices,
      "chat",
      "hello",
      snapshot
    );
    expect(sent.indexOf("hello")).toBe(0);
    expect(sent.indexOf("<system_reminder>")).toBeGreaterThan("hello".length);
  });
});

describe("who is owed a note", () => {
  const service = (): InstanceType<typeof EnvironmentNoticeService> =>
    new EnvironmentNoticeService();

  it("owes the list to a conversation that has never been told", () => {
    const notices = service();
    notices.markSessionStarted("fresh");
    expect(notices.isPending("fresh")).toBe(true);
  });

  it("stops owing it once that first message has gone", () => {
    const notices = service();
    notices.markSessionStarted("fresh");
    notices.markAnnounced("fresh");
    expect(notices.isPending("fresh")).toBe(false);
  });

  it("owes it again when the agent process restarts, history and all", () => {
    const notices = service();
    notices.markSessionStarted("revived");
    notices.markAnnounced("revived");
    notices.markSessionStarted("revived");
    expect(notices.isPending("revived")).toBe(true);
  });

  it("owes a note to a session that was already running", () => {
    const notices = service();
    notices.markSessionStarted("running");
    notices.markChanged();
    expect(notices.isPending("running")).toBe(true);
  });

  it("sends the note once, not on every later message", () => {
    const notices = service();
    notices.markSessionStarted("running");
    notices.markChanged();
    expect(notices.isPending("running")).toBe(true);
    notices.markAnnounced("running");
    expect(notices.isPending("running")).toBe(false);
  });

  it("sends a second note when something changes again", () => {
    const notices = service();
    notices.markSessionStarted("running");
    notices.markChanged();
    notices.markAnnounced("running");
    notices.markChanged();
    expect(notices.isPending("running")).toBe(true);
  });

  it("tells every running session, not only the one that made the change", () => {
    const notices = service();
    notices.markSessionStarted("a");
    notices.markSessionStarted("b");
    notices.markChanged();
    expect(notices.isPending("a")).toBe(true);
    expect(notices.isPending("b")).toBe(true);
  });

  it("tells a session it has never seen, rather than assuming it knows", () => {
    const notices = service();
    expect(notices.isPending("unknown")).toBe(true);
  });
});

/**
 * The regression guard. Each case is a real path a user takes in the UI, and
 * each must raise the flag for a conversation that is already open — this is
 * what stops the reported bug coming back for a connector, an MCP server, a
 * connector or a skill that is added later.
 */
describe("every way the environment changes raises the flag", () => {
  const SESSION = "open-chat";

  beforeEach(() => {
    // Settled: told once already, so anything pending here came from the case.
    environmentNoticeService.markAnnounced(SESSION);
    expect(environmentNoticeService.isPending(SESSION)).toBe(false);
  });

  const mcp = (): InstanceType<typeof McpConfigService> =>
    new McpConfigService();

  it("adding an MCP server (this is also how a connector is installed)", () => {
    mcp().addUserServer("code", "github", { url: "https://example.test/mcp" });
    expect(environmentNoticeService.isPending(SESSION)).toBe(true);
  });

  it("editing an MCP server", () => {
    const service = mcp();
    service.addUserServer("code", "edit-me", {
      url: "https://example.test/mcp",
    });
    environmentNoticeService.markAnnounced(SESSION);
    service.updateUserServer("code", "edit-me", {
      url: "https://elsewhere.test/mcp",
    });
    expect(environmentNoticeService.isPending(SESSION)).toBe(true);
  });

  it("disabling an MCP server", () => {
    const service = mcp();
    service.addUserServer("code", "toggle-me", {
      url: "https://example.test/mcp",
    });
    environmentNoticeService.markAnnounced(SESSION);
    service.setUserServerDisabled("code", "toggle-me", true);
    expect(environmentNoticeService.isPending(SESSION)).toBe(true);
  });

  it("removing an MCP server", () => {
    const service = mcp();
    service.addUserServer("code", "remove-me", {
      url: "https://example.test/mcp",
    });
    environmentNoticeService.markAnnounced(SESSION);
    service.removeUserServer("code", "remove-me");
    expect(environmentNoticeService.isPending(SESSION)).toBe(true);
  });

  it("importing MCP servers from another agent config", () => {
    mcp().mergeUserServers("code", {
      imported: { url: "https://example.test/mcp" },
    });
    expect(environmentNoticeService.isPending(SESSION)).toBe(true);
  });

  it("enabling a messaging connector", () => {
    messagingConfig.setPlatformEnabled("discord", true);
    expect(environmentNoticeService.isPending(SESSION)).toBe(true);
  });

  it("saving a connector credential, which is what connects it", () => {
    messagingConfig.savePlatformValues("discord", {
      botToken: "xoxb-not-a-real-token",
    });
    expect(environmentNoticeService.isPending(SESSION)).toBe(true);
  });

  it("importing a skill from disk", async () => {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "skill-src-"));
    fs.writeFileSync(
      path.join(source, "demo.md"),
      "---\nname: demo\ndescription: demo\n---\nbody\n"
    );
    const result = await new SkillsService().importFromPaths({
      paths: [path.join(source, "demo.md")],
      kind: "file",
    });
    expect(result.success).toBe(true);
    expect(environmentNoticeService.isPending(SESSION)).toBe(true);
    fs.rmSync(source, { recursive: true, force: true });
  });

  it("removing a skill", async () => {
    const service = new SkillsService();
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "skill-src-"));
    fs.writeFileSync(
      path.join(source, "goner.md"),
      "---\nname: goner\ndescription: goner\n---\nbody\n"
    );
    await service.importFromPaths({
      paths: [path.join(source, "goner.md")],
      kind: "file",
    });
    environmentNoticeService.markAnnounced(SESSION);

    const removed = service.remove({
      path: path.join(HOME, "skills", "goner.md"),
    });
    expect(removed.success).toBe(true);
    expect(environmentNoticeService.isPending(SESSION)).toBe(true);
    fs.rmSync(source, { recursive: true, force: true });
  });
});
