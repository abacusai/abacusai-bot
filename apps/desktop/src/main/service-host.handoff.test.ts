/**
 * `hand_off_session`: a task split off into a new chat beside its source, on
 * the real session manager. It carries the chat's folders, attached files,
 * checkout, model and mode; it is titled and sent its task; it is offered and
 * run only in the user's own app chat; and only a few run at once.
 */
import { AgentMode } from "@abacus-ai/contract/agent-types";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const WORKSPACE = "ws-1";
const WORKTREE = {
  id: "wt-1",
  path: "/repo/.worktrees/fix-login",
  branch: "fix-login",
  isCurrent: false,
};

type Sent = { workspaceId: string; sessionId: string; message: string };

const proto = ServiceHost.prototype as unknown as Record<
  string,
  (...args: unknown[]) => unknown
>;

/** A ServiceHost whose session side is real and whose agent side is recorded. */
const makeHost = (
  options: {
    platform?: string;
    busy?: Set<string>;
    gatewaySessions?: Set<string>;
    worktrees?: (typeof WORKTREE)[];
    running?: Set<string>;
  } = {}
) => {
  const manager = new AgentSessionManagerService();
  manager.initialize([WORKSPACE]);
  const sent: Sent[] = [];
  const events: Array<{ type: string; sessionId?: string; label?: string }> =
    [];
  const self: Record<string, unknown> = {
    platform: options.platform ?? "desktop",
    agentSessionManagerService: manager,
    handOffsStarting: new Set<string>(),
    hostedRunSessions: new Set<string>(),
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
    listWorktrees: async () => ({
      success: true,
      worktrees: options.worktrees ?? [WORKTREE],
    }),
    isWorkspaceDeleted: () => false,
    emitEvent: (event: { type: string; sessionId?: string; label?: string }) =>
      events.push(event),
    sendAgentMessage: async (request: Sent) => {
      sent.push(request);
      return true;
    },
    removeAgentSession: (workspaceId: string, sessionId: string) =>
      manager.remove(workspaceId, sessionId),
  };
  for (const name of [
    "isPlainAppChat",
    "isUnattendedSession",
    "heldPolicy",
    "handOffSession",
    "createAgentSession",
    "setSessionWorktree",
    "updateAgentSessionLabel",
  ])
    self[name] = proto[name]!.bind(self);
  const handOff = (from: string, title = "Fix the login crash") =>
    (
      self.handOffSession as (
        from: string,
        task: { title: string; prompt: string }
      ) => Promise<{ sessionId: string } | { error: string }>
    )(from, { title, prompt: `Brief: ${title}` });
  return {
    manager,
    sent,
    events,
    handOff,
    plain: self.isPlainAppChat as (id: string) => boolean,
  };
};

beforeEach(() => stored.clear());

describe("a hand-off from the user's own chat", () => {
  it("runs on everything the chat runs on: folders, attached files, checkout, model and mode", async () => {
    const { manager, sent, handOff } = makeHost();
    const source = manager.create(WORKSPACE, null, null, null, undefined, {
      model: "abacus/claude-opus-5-5",
      mode: AgentMode.PlanMode,
    });
    manager.updateWorktree(WORKSPACE, source.id, WORKTREE);
    manager.addFolder(source.id, "/Users/dev/Drive/site");
    manager.addFolder(source.id, "/Users/dev/Drive/api");
    manager.addAttachedFile(source.id, "/Users/dev/Desktop/brief.pdf");

    const started = await handOff(source.id);
    if (!("sessionId" in started)) throw new Error(started.error);
    const made = manager.get(started.sessionId)!;
    expect(made).toMatchObject({
      workspaceId: WORKSPACE,
      label: "Fix the login crash",
      model: "abacus/claude-opus-5-5",
      mode: AgentMode.PlanMode,
      continuedFrom: source.id,
      continuationKind: "handoff",
      worktreeId: WORKTREE.id,
      worktreePath: WORKTREE.path,
      worktreeBranch: WORKTREE.branch,
      folders: ["/Users/dev/Drive/site", "/Users/dev/Drive/api"],
    });
    expect(manager.attachedFiles(made.id)).toEqual([
      "/Users/dev/Desktop/brief.pdf",
    ]);
    // The task itself is its first message: no summary is owed.
    expect(manager.continuationSeed(made.id)).toBeNull();
    expect(sent).toEqual([
      {
        workspaceId: WORKSPACE,
        sessionId: made.id,
        message: "Brief: Fix the login crash",
      },
    ]);
    // Its title is set, so the first message does not rename it.
    expect(
      manager.nameFromMessage(made.id, "Brief: Fix the login crash")
    ).toBeNull();
    // The source is untouched and keeps going.
    expect(manager.get(source.id)).not.toHaveProperty("continuedFrom");
  });

  it.each(
    Object.values(AgentMode).flatMap((mode) =>
      [null, "abacus/claude-opus-5-5", "deepseek/deepseek-v4.1-flash"].map(
        (model) => [mode, model] as const
      )
    )
  )("keeps mode %s and model %s", async (mode, model) => {
    const { manager, handOff } = makeHost();
    const source = manager.create(WORKSPACE, null, null, null, undefined, {
      mode,
      model,
    });
    const started = await handOff(source.id);
    if (!("sessionId" in started)) throw new Error(started.error);
    expect(manager.get(started.sessionId)).toMatchObject({ mode, model });
  });

  it("from a chat on the project's own checkout and one folder, stays there", async () => {
    const { manager, handOff } = makeHost();
    const source = manager.create(WORKSPACE, null, null, null, undefined, {
      mode: AgentMode.Normal,
    });
    const started = await handOff(source.id);
    if (!("sessionId" in started)) throw new Error(started.error);
    expect(manager.get(started.sessionId)).toMatchObject({
      worktreeId: null,
      worktreePath: null,
      mode: AgentMode.Normal,
    });
    expect(manager.get(started.sessionId)).not.toHaveProperty("folders");
  });

  it("while the source's turn runs, starts beside it without touching it", async () => {
    const working = new Set<string>();
    const { manager, sent, handOff } = makeHost({
      running: working,
      busy: working,
    });
    const source = manager.create(WORKSPACE);
    manager.updateWorktree(WORKSPACE, source.id, WORKTREE);
    working.add(source.id);
    const started = await handOff(source.id);
    if (!("sessionId" in started)) throw new Error(started.error);
    expect(manager.get(started.sessionId)?.worktreeId).toBe(WORKTREE.id);
    expect(sent.map((each) => each.sessionId)).toEqual([started.sessionId]);
    expect(manager.get(source.id)?.worktreeId).toBe(WORKTREE.id);
  });

  it("refuses when the chat's checkout is gone, and leaves no chat behind", async () => {
    const { manager, sent, handOff } = makeHost({ worktrees: [] });
    const source = manager.create(WORKSPACE);
    manager.updateWorktree(WORKSPACE, source.id, WORKTREE);
    const before = manager.list(WORKSPACE).length;
    expect(await handOff(source.id)).toHaveProperty("error");
    expect(manager.list(WORKSPACE)).toHaveLength(before);
    expect(sent).toEqual([]);
  });

  it("lets at most three handed-off chats work at once; a finished one frees a slot", async () => {
    const busy = new Set<string>();
    const { manager, handOff } = makeHost({ busy });
    const source = manager.create(WORKSPACE);
    for (let n = 0; n < 3; n += 1) {
      const started = await handOff(source.id, `Task ${n}`);
      if (!("sessionId" in started)) throw new Error(started.error);
      busy.add(started.sessionId);
    }
    expect(await handOff(source.id, "Task 4")).toHaveProperty("error");
    busy.delete([...busy][0]!);
    expect(await handOff(source.id, "Task 4")).toHaveProperty("sessionId");
  });

  it("counts hand-offs still attaching their checkout, so parallel calls cannot pass the cap", async () => {
    const { manager, handOff } = makeHost();
    const source = manager.create(WORKSPACE);
    manager.updateWorktree(WORKSPACE, source.id, WORKTREE);
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => handOff(source.id, `Task ${n}`))
    );
    expect(results.filter((result) => "error" in result)).toHaveLength(1);
  });
});

describe("chats that never hand off", () => {
  it("a bot's chat, a routine's run, a routine editor, a lane, a chat app's chat, the hosted computer, an unknown id", async () => {
    const gateway = new Set<string>();
    const host = makeHost({ gatewaySessions: gateway });
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
      isPlainAppChat: (id: string) => plain.has(id),
      handOffSession: handOff,
    } as never);

  it("is listed and runs only where the host says it is the user's own app chat", async () => {
    const handOff = vi.fn(async () => ({ sessionId: "new-chat" }));
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
