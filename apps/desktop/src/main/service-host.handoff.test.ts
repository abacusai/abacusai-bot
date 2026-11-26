/**
 * `hand_off_session`: a task split off into a new chat beside its source, on
 * the real session manager and real git. In a git project the new chat gets a
 * checkout of its own made from the source's last commit; anywhere else it
 * shares the folder and is told so. It carries the chat's folders, attached
 * files, model and mode; its first message is the app's note with the brief,
 * never the user's words. It is offered only in the user's own app chat, never
 * in a chat that was itself handed off, and within caps per message, per day
 * and working at once. It never starts past the credit wall.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ownWords, visibleUserText } from "@abacus-ai/agent/user-text";
import { AgentMode, type UserTextTags } from "@abacus-ai/contract/agent-types";
import { OPENLLM_ID } from "@abacus-ai/contract/models";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
  const anything: unknown = new Proxy(function () {}, {
    get: (_target, property) => (property === "then" ? undefined : anything),
    apply: () => anything,
    construct: () => anything as object,
  });
  return new Proxy(
    { default: anything },
    {
      get: (target, property) =>
        property in target
          ? (target as Record<PropertyKey, unknown>)[property]
          : property === "then"
            ? undefined
            : anything,
      has: () => true,
    }
  );
});

const stored = new Map<string, unknown>();
vi.mock("./services/session/workspace-store", () => ({
  workspaceStore: {
    get: (key: string) => stored.get(key),
    set: (key: string, value: unknown) => stored.set(key, value),
  },
}));

const { ServiceHost } = await import("./service-host");
const { AgentSessionManagerService } =
  await import("./services/session/agent-session-manager-service");
const { McpAgentToolsServer } =
  await import("./services/mcp/mcp-agent-tools-server");
const { GitService } = await import("./services/workspace/git-service");
const { WorktreeMaterializer } =
  await import("./services/workspace/worktree-materialize");
const { turnOpenerOf } = await import("./services/session/turn-ledger");
const { handOffEndOf } = await import("./services/session/hand-off");

const WORKSPACE = "ws-1";

type Sent = {
  workspaceId: string;
  sessionId: string;
  message: string;
  userText?: UserTextTags;
};

const proto = ServiceHost.prototype as unknown as Record<
  string,
  (...args: unknown[]) => unknown
>;

let tmp = "";
beforeEach(() => {
  stored.clear();
  tmp = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "handoff-"))
  );
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** A project folder: a git repo with one commit, or a plain folder. */
const project = (kind: "git" | "plain"): string => {
  const dir = path.join(tmp, "project");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  if (kind === "git") {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "add", ".");
    git(
      dir,
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "first"
    );
  }
  return dir;
};

/**
 * A ServiceHost whose session side, git and worktree path are real, and
 * whose agent side (the send, the turn state, the credit wall) is recorded.
 */
const makeHost = (
  options: {
    folder?: string;
    platform?: string;
    busy?: Set<string>;
    gatewaySessions?: Set<string>;
    running?: Set<string>;
    creditWall?: boolean;
    sendFails?: boolean;
    turns?: Map<string, string>;
  } = {}
) => {
  const manager = new AgentSessionManagerService();
  manager.initialize([WORKSPACE]);
  const sent: Sent[] = [];
  const creditChecks: string[] = [];
  const self: Record<string, unknown> = {
    platform: options.platform ?? "desktop",
    agentSessionManagerService: manager,
    handOffsStarting: new Set<string>(),
    handOffTurns: new Map(),
    hostedRunSessions: new Set<string>(),
    gitService: new GitService(),
    workspaceService: {
      getWorkspaces: () => [
        { id: WORKSPACE, path: options.folder ?? null, isRemote: false },
      ],
    },
    managedWorktreeRoot: () => path.join(tmp, "worktrees"),
    messagingGatewayService: {
      servesSession: (id: string) => options.gatewaySessions?.has(id) === true,
    },
    sessionTurnStateService: {
      get: (_workspaceId: string, sessionId: string) => ({
        isBusy: options.busy?.has(sessionId) === true,
      }),
    },
    agentManagerService: {
      getSessionState: (_workspaceId: string, sessionId: string) => ({
        status: options.running?.has(sessionId) === true ? "running" : "idle",
      }),
    },
    turnLedger: {
      openTurnId: (sessionId: string) => options.turns?.get(sessionId) ?? null,
    },
    atCreditWall: async (model: string) => {
      creditChecks.push(model);
      return options.creditWall === true;
    },
    isWorkspaceDeleted: () => false,
    emitEvent: () => undefined,
    sendAgentMessage: async (request: Sent) => {
      sent.push(request);
      return options.sendFails !== true;
    },
    removeAgentSession: (workspaceId: string, sessionId: string) =>
      manager.remove(workspaceId, sessionId),
  };
  for (const name of [
    "isPlainAppChat",
    "mayHandOff",
    "isUnattendedSession",
    "heldPolicy",
    "handOffSession",
    "createAgentSession",
    "setSessionWorktree",
    "createWorktree",
    "listWorktrees",
    "localWorkspacePath",
    "materializeSessionWorktree",
    "updateAgentSessionLabel",
  ])
    self[name] = proto[name]!.bind(self);
  self.worktreeMaterializer = new WorktreeMaterializer({
    session: (id) => manager.get(id),
    recorded: (id) => manager.worktreeOperation(id),
    create: (request) =>
      (self.createWorktree as (r: typeof request) => Promise<never>)(request),
    attach: (request) =>
      (self.setSessionWorktree as (r: typeof request) => Promise<never>)(
        request
      ),
    remove: async () => undefined,
  });
  const handOff = (from: string, title = "Fix the login crash") =>
    (
      self.handOffSession as (
        from: string,
        task: { title: string; prompt: string }
      ) => Promise<
        { sessionId: string; sharedFolder: boolean } | { error: string }
      >
    )(from, { title, prompt: `Brief: ${title}` });
  return {
    manager,
    sent,
    creditChecks,
    handOff,
    plain: self.isPlainAppChat as (id: string) => boolean,
    mayHandOff: self.mayHandOff as (id: string) => boolean,
  };
};

const started = (
  result: { sessionId: string; sharedFolder: boolean } | { error: string }
) => {
  if ("error" in result) throw new Error(result.error);
  return result;
};

describe("a hand-off from the user's own chat", () => {
  it("in a git project: a checkout of its own from the chat's last commit, with its folders, files, model and mode", async () => {
    const folder = project("git");
    const { manager, sent, handOff, creditChecks } = makeHost({ folder });
    const source = manager.create(WORKSPACE, null, null, null, undefined, {
      model: "abacus/claude-opus-5-5",
      mode: AgentMode.Normal,
    });
    manager.addFolder(source.id, "/Users/dev/Drive/site");
    manager.addFolder(source.id, "/Users/dev/Drive/api");
    manager.addAttachedFile(source.id, "/Users/dev/Desktop/brief.pdf");

    const result = started(await handOff(source.id));
    expect(result.sharedFolder).toBe(false);
    const made = manager.get(result.sessionId)!;
    expect(made).toMatchObject({
      label: "Fix the login crash",
      model: "abacus/claude-opus-5-5",
      mode: AgentMode.Normal,
      continuedFrom: source.id,
      continuationKind: "handoff",
      folders: ["/Users/dev/Drive/site", "/Users/dev/Drive/api"],
    });
    expect(manager.attachedFiles(made.id)).toEqual([
      "/Users/dev/Desktop/brief.pdf",
    ]);
    // Its own checkout, on the source's commit, apart from the source's.
    expect(made.worktreePath).not.toBeNull();
    expect(made.worktreePath).not.toBe(folder);
    expect(git(made.worktreePath!, "rev-parse", "HEAD")).toBe(
      git(folder, "rev-parse", "HEAD")
    );
    expect(fs.existsSync(path.join(made.worktreePath!, "README.md"))).toBe(
      true
    );
    expect(manager.get(source.id)?.worktreePath).toBeNull();
    expect(manager.continuationSeed(made.id)).toBeNull();
    expect(creditChecks).toEqual(["abacus/claude-opus-5-5"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toContain("checkout of your own");
  });

  it("from a chat on a worktree: the new checkout starts from that worktree's commit", async () => {
    const folder = project("git");
    const host = makeHost({ folder });
    const first = started(
      await host.handOff(host.manager.create(WORKSPACE).id)
    );
    const branchChat = host.manager.get(first.sessionId)!;
    // A commit only on the first worktree, then a plain chat on it.
    fs.writeFileSync(path.join(branchChat.worktreePath!, "new.txt"), "x");
    git(branchChat.worktreePath!, "add", ".");
    git(
      branchChat.worktreePath!,
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "-qm",
      "second"
    );
    const onWorktree = host.manager.create(WORKSPACE);
    host.manager.updateWorktree(WORKSPACE, onWorktree.id, {
      id: branchChat.worktreeId!,
      path: branchChat.worktreePath!,
      branch: branchChat.worktreeBranch,
    });
    const next = host.manager.get(
      started(await host.handOff(onWorktree.id)).sessionId
    )!;
    expect(git(next.worktreePath!, "rev-parse", "HEAD")).toBe(
      git(branchChat.worktreePath!, "rev-parse", "HEAD")
    );
    expect(next.worktreePath).not.toBe(branchChat.worktreePath);
  });

  it("in a folder without git: shares it, and both chats are told", async () => {
    const folder = project("plain");
    const { manager, sent, handOff } = makeHost({ folder });
    const source = manager.create(WORKSPACE);
    const result = started(await handOff(source.id));
    expect(result.sharedFolder).toBe(true);
    expect(manager.get(result.sessionId)?.worktreePath).toBeNull();
    expect(sent[0]!.message).toContain("works in the same folder");
  });

  it("sends the brief as the app's note: never the user's words, opener or success-pitch words", async () => {
    const { manager, sent, handOff } = makeHost({ folder: project("plain") });
    const source = manager.create(WORKSPACE);
    manager.updateLabel(WORKSPACE, source.id, "Ship 1.2");
    const result = started(await handOff(source.id));
    const [{ message, userText }] = sent as [Sent];
    expect(userText).toEqual({
      operator: {
        kind: "handoff",
        handoff: {
          fromSessionId: source.id,
          brief: "Brief: Fix the login crash",
        },
      },
    });
    expect(message).toMatch(/^\[handed off\] The user's chat "Ship 1.2"/);
    expect(message.endsWith("Brief: Fix the login crash")).toBe(true);
    // What noteUserWords, the success pitch and naming read: nothing.
    expect(visibleUserText(message, userText)).toBe("");
    expect(ownWords(message, userText)).toBe("");
    expect(turnOpenerOf(message, userText)).toBe("app");
    expect(
      manager.nameFromMessage(result.sessionId, message, userText)
    ).toBeNull();
  });

  it.each(
    Object.values(AgentMode).flatMap((mode) =>
      [null, "abacus/claude-opus-5-5", "deepseek/deepseek-v4.1-flash"].map(
        (model) => [mode, model] as const
      )
    )
  )("keeps mode %s and model %s", async (mode, model) => {
    const { manager, handOff, creditChecks } = makeHost({
      folder: project("plain"),
    });
    const source = manager.create(WORKSPACE, null, null, null, undefined, {
      mode,
      model,
    });
    const result = started(await handOff(source.id));
    expect(manager.get(result.sessionId)).toMatchObject({ mode, model });
    // A chat with no model of its own runs on the router, which bills.
    expect(creditChecks).toEqual([model ?? OPENLLM_ID]);
  });

  it("while the source's turn runs, starts beside it without touching it", async () => {
    const working = new Set<string>();
    const { manager, sent, handOff } = makeHost({
      folder: project("git"),
      running: working,
      busy: working,
    });
    const source = manager.create(WORKSPACE);
    working.add(source.id);
    const result = started(await handOff(source.id));
    expect(sent.map((each) => each.sessionId)).toEqual([result.sessionId]);
    expect(manager.get(source.id)?.worktreeId).toBeNull();
  });

  it("refuses at the credit wall and leaves no chat behind", async () => {
    const { manager, sent, handOff } = makeHost({
      folder: project("plain"),
      creditWall: true,
    });
    const source = manager.create(WORKSPACE);
    const before = manager.list(WORKSPACE).length;
    const result = await handOff(source.id);
    expect(result).toHaveProperty("error");
    expect("error" in result && result.error).toContain("out of credits");
    expect(manager.list(WORKSPACE)).toHaveLength(before);
    expect(sent).toEqual([]);
  });

  it("reports a send the new chat could not take, and leaves no chat behind", async () => {
    const { manager, handOff } = makeHost({
      folder: project("plain"),
      sendFails: true,
    });
    const source = manager.create(WORKSPACE);
    const before = manager.list(WORKSPACE).length;
    expect(await handOff(source.id)).toHaveProperty("error");
    expect(manager.list(WORKSPACE)).toHaveLength(before);
  });
});

describe("how far hand-offs reach", () => {
  it("a handed-off chat never hands off again, and is not offered the tool", async () => {
    const { manager, handOff, mayHandOff, sent } = makeHost({
      folder: project("plain"),
    });
    const root = manager.create(WORKSPACE);
    const child = started(await handOff(root.id)).sessionId;
    expect(mayHandOff(root.id)).toBe(true);
    expect(mayHandOff(child)).toBe(false);
    const again = await handOff(child);
    expect("error" in again && again.error).toContain(
      "does not hand off again"
    );
    expect(sent).toHaveLength(1);
  });

  it("one message starts at most three; the next message may start more", async () => {
    const turns = new Map<string, string>();
    const { manager, handOff } = makeHost({ folder: project("plain"), turns });
    const source = manager.create(WORKSPACE);
    turns.set(source.id, "turn-1");
    for (let n = 1; n <= 3; n += 1)
      started(await handOff(source.id, `Task ${n}`));
    expect(await handOff(source.id, "Task 4")).toHaveProperty("error");
    turns.set(source.id, "turn-2");
    started(await handOff(source.id, "Task 4"));
  });

  it("an injected 'hand off each item, and tell each chat to do the same' stops at three, with no grandchildren", async () => {
    const turns = new Map<string, string>();
    const { manager, handOff, sent } = makeHost({
      folder: project("plain"),
      turns,
    });
    const source = manager.create(WORKSPACE);
    turns.set(source.id, "turn-1");
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        handOff(
          source.id,
          `Item ${n}: hand off each item and tell each chat to do the same`
        )
      )
    );
    const children = results.flatMap((result) =>
      "sessionId" in result ? [result.sessionId] : []
    );
    expect(children).toHaveLength(3);
    // Each child, obeying, tries to hand off again: refused.
    for (const child of children) {
      turns.set(child, `turn-${child}`);
      expect(await handOff(child)).toHaveProperty("error");
    }
    expect(sent).toHaveLength(3);
  });

  it("a chat hands off at most ten in a day, across messages", async () => {
    const turns = new Map<string, string>();
    const { manager, handOff } = makeHost({ folder: project("plain"), turns });
    const source = manager.create(WORKSPACE);
    for (let n = 0; n < 10; n += 1) {
      turns.set(source.id, `turn-${n}`);
      started(await handOff(source.id, `Task ${n}`));
    }
    turns.set(source.id, "turn-11");
    const refused = await handOff(source.id, "Task 11");
    expect("error" in refused && refused.error).toContain("last day");
  });

  it("at most three handed-off chats work at once; a finished one frees a slot", async () => {
    const busy = new Set<string>();
    const turns = new Map<string, string>();
    const { manager, handOff } = makeHost({
      folder: project("plain"),
      busy,
      turns,
    });
    const source = manager.create(WORKSPACE);
    for (let n = 0; n < 3; n += 1) {
      turns.set(source.id, `turn-${n}`);
      busy.add(started(await handOff(source.id, `Task ${n}`)).sessionId);
    }
    turns.set(source.id, "turn-3");
    expect(await handOff(source.id, "Task 3")).toHaveProperty("error");
    busy.delete([...busy][0]!);
    started(await handOff(source.id, "Task 3"));
  });

  it("a refused start gives its place in the message back", async () => {
    const turns = new Map<string, string>([]);
    const host = makeHost({
      folder: project("plain"),
      turns,
      sendFails: true,
    });
    const source = host.manager.create(WORKSPACE);
    turns.set(source.id, "turn-1");
    for (let n = 0; n < 5; n += 1)
      expect(await host.handOff(source.id)).toHaveProperty("error");
    const last = await host.handOff(source.id);
    expect("error" in last && last.error).not.toContain("from this message");
  });
});

describe("how the card reads a handed-off chat's ending", () => {
  it.each([
    ["reply", "done"],
    ["stopped", "stopped"],
    ["app_closed", "stopped"],
    ["failed", "failed"],
    ["timed_out", "failed"],
    ["agent_exited", "failed"],
    ["not_started", "failed"],
  ] as const)("%s reads as %s", (end, shown) => {
    expect(handOffEndOf(end)).toBe(shown);
  });

  it("is stamped on a handed-off chat only", () => {
    const manager = new AgentSessionManagerService();
    manager.initialize([WORKSPACE]);
    const plain = manager.create(WORKSPACE);
    const child = manager.create(WORKSPACE, null, null, null, undefined, {
      continuedFrom: { sessionId: plain.id, kind: "handoff" },
    });
    expect(manager.setHandOffEnd(plain.id, "done")).toBe(false);
    expect(manager.setHandOffEnd(child.id, "done")).toBe(true);
    expect(manager.get(child.id)?.handOffEnd).toBe("done");
    expect(manager.get(plain.id)).not.toHaveProperty("handOffEnd");
  });
});

describe("chats that never hand off", () => {
  it("a bot's chat, a routine's run, a routine editor, a lane, a chat app's chat, the hosted computer, an unknown id", async () => {
    const gateway = new Set<string>();
    const host = makeHost({
      gatewaySessions: gateway,
      folder: project("plain"),
    });
    const { manager } = host;
    const bot = manager.create(WORKSPACE, null, {
      kind: "bot",
      botId: "b1",
      role: "forever",
      key: null,
    });
    const routine = manager.create(WORKSPACE, "routine-1");
    const editor = manager.editorFor("routine-1", WORKSPACE);
    const lane = manager.laneSession("phone", WORKSPACE, AgentMode.Normal);
    const stranger = manager.create(WORKSPACE, null, null, null, undefined, {
      chatAppSender: true,
    });
    const ownChatApp = manager.create(WORKSPACE);
    gateway.add(ownChatApp.id);
    for (const id of [
      bot.id,
      routine.id,
      editor.id,
      lane.id,
      stranger.id,
      ownChatApp.id,
      "gone",
    ]) {
      expect(host.plain(id)).toBe(false);
      expect(await host.handOff(id)).toHaveProperty("error");
    }
    const hosted = makeHost({ platform: "web-host" });
    const chat = hosted.manager.create(WORKSPACE);
    expect(hosted.plain(chat.id)).toBe(false);
    expect(await hosted.handOff(chat.id)).toHaveProperty("error");
    expect(host.sent).toEqual([]);
  });
});

describe("the tool's reach", () => {
  const server = (plain: Set<string>, handOff = vi.fn()) =>
    new McpAgentToolsServer({
      skillsService: {} as never,
      enabledToolsets: () => new Set<string>(),
      workspacePath: () => null,
      botIdForSession: (id: string) => (id === "bot-chat" ? "bot-1" : null),
      mayHandOff: (id: string) => plain.has(id),
      handOffSession: handOff,
    } as never);

  it("is listed and runs only where the host says it is the user's own app chat", async () => {
    const handOff = vi.fn(async () => ({
      sessionId: "new-chat",
      sharedFolder: false,
    }));
    const tools = server(new Set(["mine"]), handOff);
    const names = (id: string) =>
      (
        tools as unknown as {
          listTools: (callerSession?: string) => Array<{ name: string }>;
        }
      )
        .listTools(id)
        .map((tool) => tool.name);
    expect(names("mine")).toContain("hand_off_session");
    for (const id of ["chat-app", "bot-chat", "unknown"])
      expect(names(id)).not.toContain("hand_off_session");

    const refused = await tools.executeTool(
      "hand_off_session",
      { title: "Fix it", prompt: "Fix the login crash" },
      "chat-app"
    );
    expect(refused.isError).toBe(true);
    expect(handOff).not.toHaveBeenCalled();

    const ran = await tools.executeTool(
      "hand_off_session",
      { title: "Fix it", prompt: "Fix the login crash" },
      "mine"
    );
    expect(ran.isError).not.toBe(true);
    expect(JSON.stringify(ran.content)).toContain("session: new-chat");
    expect(handOff).toHaveBeenCalledWith("mine", {
      title: "Fix it",
      prompt: "Fix the login crash",
    });
  });

  it("asks for a title and a brief", async () => {
    const handOff = vi.fn();
    const tools = server(new Set(["mine"]), handOff);
    const result = await tools.executeTool(
      "hand_off_session",
      { title: " ", prompt: "x" },
      "mine"
    );
    expect(result.isError).toBe(true);
    expect(handOff).not.toHaveBeenCalled();
  });
});
