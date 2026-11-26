import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  conversationKey,
  draftConversationRef,
  sessionConversationRef,
} from "@abacus-ai/contract/conversation-scope";
import type { TerminalShellId } from "@abacus-ai/contract/terminal-shells";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalSessionService } from "./terminal-session-service";

const ptySpawn = vi.fn();
const storedShell = vi.fn<() => TerminalShellId>(() => "system");
const resolveShell = vi.fn((id: TerminalShellId) => ({
  id,
  file: `/bin/${id}`,
  args: ["-l"],
  env: id === "busybox" ? { BB_OVERRIDE_APPLETS: ";tar" } : undefined,
}));

vi.mock("./terminal-shells", () => ({
  resolveTerminalShell: (id: TerminalShellId) => resolveShell(id),
  preferredTerminalShell: () => storedShell(),
  learnTerminalShell: async () => {},
}));

vi.mock("@lydell/node-pty", () => ({
  spawn: (...args: unknown[]) => ptySpawn(...args) as unknown,
}));

const fakePty = (foreground = "system") => ({
  process: foreground,
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
});

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-session-"));
  storedShell.mockClear();
  resolveShell.mockClear();
  storedShell.mockReturnValue("system");
  ptySpawn.mockReset();
  ptySpawn.mockImplementation(() => fakePty());
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

const service = (): TerminalSessionService =>
  new TerminalSessionService({
    resolveWorkspacePath: () => workspace,
    emitTerminalOutput: () => {},
    emitTerminalExit: () => {},
    emitTerminalState: () => {},
  });

const draftRequest = () => {
  // A new chat's draft carries its id, as the renderer sends it.
  const conversation = draftConversationRef("workspace-1", "draft-1");
  return {
    conversation,
    conversationKey: conversationKey(conversation),
    generation: null,
    cols: 80,
    rows: 24,
  };
};

describe("conversation terminal session service", () => {
  it("announces a closed generation as retired, since its exit is suppressed", async () => {
    const retired = vi.fn();
    const exited = vi.fn();
    const terminals = new TerminalSessionService({
      resolveWorkspacePath: () => workspace,
      emitTerminalOutput: () => {},
      emitTerminalExit: exited,
      emitTerminalState: () => {},
      emitTerminalRetired: retired,
    });
    const request = draftRequest();
    const { state } = await terminals.startSession(request);

    terminals.hideSession({
      conversationKey: request.conversationKey,
      conversation: request.conversation,
      generation: state.generation,
      close: true,
    } as Parameters<TerminalSessionService["hideSession"]>[0]);

    expect(retired).toHaveBeenCalledExactlyOnceWith({
      terminalId: "terminal-1",
      conversationKey: request.conversationKey,
      generation: state.generation,
      reason: "closed",
    });
    expect(exited).not.toHaveBeenCalled();
  });

  it("opens the shell the request names", async () => {
    const terminals = service();

    const result = await terminals.startSession({
      ...draftRequest(),
      shell: "busybox",
    });

    expect(result.state.shell).toBe("busybox");
    expect(ptySpawn).toHaveBeenCalledWith(
      "/bin/busybox",
      ["-l"],
      expect.objectContaining({
        cwd: workspace,
        env: expect.objectContaining({ BB_OVERRIDE_APPLETS: ";tar" }),
      })
    );
  });

  it("opens the stored shell when the request names none", async () => {
    // What an automatically opened terminal sends: the last shell picked is
    // the one that comes back, with nobody asked.
    storedShell.mockReturnValue("powershell");
    const terminals = service();

    const result = await terminals.startSession(draftRequest());

    expect(result.state.shell).toBe("powershell");
    expect(ptySpawn).toHaveBeenCalledWith(
      "/bin/powershell",
      ["-l"],
      expect.objectContaining({ cwd: workspace })
    );
  });

  it("keeps a promoted terminal on the shell it was opened with", async () => {
    storedShell.mockReturnValue("system");
    const resolveWorkspacePath = vi.fn(
      (_workspaceId: string, sessionId?: string) =>
        sessionId == null ? workspace : path.join(workspace, sessionId)
    );
    const terminals = new TerminalSessionService({
      resolveWorkspacePath,
      emitTerminalOutput: () => {},
      emitTerminalExit: () => {},
      emitTerminalState: () => {},
    });
    const draft = draftRequest();
    await terminals.startSession({ ...draft, shell: "busybox" });

    // The session checkout differs from the draft's, so the PTY is restarted;
    // the preference has moved on, and the tab must not move with it.
    storedShell.mockReturnValue("cmd");
    const session = sessionConversationRef("workspace-1", "chat-a");
    const promoted = await terminals.promoteDraftToSession({
      draftConversation: draft.conversation,
      draftConversationKey: draft.conversationKey,
      sessionConversation: session,
      sessionConversationKey: conversationKey(session),
    });

    expect(promoted?.shell).toBe("busybox");
  });

  it("serializes racing starts for one conversation", async () => {
    const terminals = service();
    const request = draftRequest();

    const [first, second] = await Promise.all([
      terminals.startSession(request),
      terminals.startSession(request),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.state.conversationKey).toBe(request.conversationKey);
    expect(ptySpawn).toHaveBeenCalledTimes(1);
  });

  it("keeps separate ptys for conversations in one workspace", async () => {
    const terminals = service();
    const draft = draftRequest();
    const savedConversation = sessionConversationRef("workspace-1", "saved");

    await terminals.startSession(draft);
    await terminals.startSession({
      ...draft,
      conversation: savedConversation,
      conversationKey: conversationKey(savedConversation),
    });

    expect(ptySpawn).toHaveBeenCalledTimes(2);
  });

  it("starts two chats in the checkout associated with each session", async () => {
    const resolveWorkspacePath = vi.fn(
      (_workspaceId: string, sessionId?: string) =>
        sessionId == null ? workspace : path.join(workspace, sessionId)
    );
    const terminals = new TerminalSessionService({
      resolveWorkspacePath,
      emitTerminalOutput: () => {},
      emitTerminalExit: () => {},
      emitTerminalState: () => {},
    });
    const first = sessionConversationRef("workspace-1", "chat-a");
    const second = sessionConversationRef("workspace-1", "chat-b");
    for (const chat of ["chat-a", "chat-b"])
      fs.mkdirSync(path.join(workspace, chat));

    for (const conversation of [first, second]) {
      await terminals.startSession({
        conversation,
        conversationKey: conversationKey(conversation),
        generation: null,
        cols: 80,
        rows: 24,
      });
    }

    expect(resolveWorkspacePath.mock.calls).toEqual([
      ["workspace-1", "chat-a"],
      ["workspace-1", "chat-b"],
    ]);
    expect(ptySpawn.mock.calls[0]?.[2]).toMatchObject({
      cwd: path.join(workspace, "chat-a"),
      // Windows gets the bundled ConPTY; without it `kill` forks a console
      // agent through the app's own executable.
      useConptyDll: process.platform === "win32",
    });
    expect(ptySpawn.mock.calls[1]?.[2]).toMatchObject({
      cwd: path.join(workspace, "chat-b"),
    });
  });

  it("promotes a draft pty without restarting it", async () => {
    const terminals = service();
    const draft = draftRequest();
    const started = await terminals.startSession(draft);
    const sessionConversation = sessionConversationRef("workspace-1", "saved");
    const sessionKey = conversationKey(sessionConversation);

    const promoted = await terminals.promoteDraftToSession({
      draftConversationKey: draft.conversationKey,
      draftConversation: draft.conversation,
      sessionConversationKey: sessionKey,
      sessionConversation,
    });

    expect(promoted?.conversationKey).toBe(sessionKey);
    expect(promoted?.generation).toBeGreaterThan(started.state.generation);
    expect(ptySpawn).toHaveBeenCalledTimes(1);
  });

  it("keeps a promoted draft's shells in a new worktree, typing nothing into them", async () => {
    const worktree = path.join(workspace, "it's-chat");
    const terminals = new TerminalSessionService({
      resolveWorkspacePath: (_workspaceId, sessionId) =>
        sessionId == null ? workspace : worktree,
      emitTerminalOutput: () => {},
      emitTerminalExit: () => {},
      emitTerminalState: () => {},
    });
    const draft = draftRequest();
    const idle = fakePty("-system");
    const busy = fakePty("vim");
    ptySpawn.mockReturnValueOnce(idle).mockReturnValueOnce(busy);
    await terminals.startSession({ ...draft, terminalId: "a" });
    await terminals.startSession({ ...draft, terminalId: "b" });
    const sessionConversation = sessionConversationRef("workspace-1", "saved");

    const promoted = await terminals.promoteDraftToSession({
      draftConversationKey: draft.conversationKey,
      draftConversation: draft.conversation,
      sessionConversationKey: conversationKey(sessionConversation),
      sessionConversation,
    });

    expect(promoted?.conversation).toEqual(sessionConversation);
    expect(ptySpawn).toHaveBeenCalledTimes(2);
    expect(idle.kill).not.toHaveBeenCalled();
    expect(busy.kill).not.toHaveBeenCalled();
    expect(idle.write).not.toHaveBeenCalled();
    expect(busy.write).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "names the terminals running a program, not those at their prompt",
    async () => {
      const terminals = service();
      const draft = draftRequest();
      ptySpawn
        .mockReturnValueOnce(fakePty("-system"))
        .mockReturnValueOnce(fakePty("python3"));
      await terminals.startSession({ ...draft, terminalId: "idle" });
      await terminals.startSession({ ...draft, terminalId: "server" });

      expect(terminals.busyTerminals()).toEqual([
        {
          key: draft.conversationKey,
          terminalId: "server",
          program: "python3",
        },
      ]);
      expect(terminals.busyProgram(draft.conversationKey, "idle")).toBeNull();
    }
  );

  it.skipIf(process.platform === "win32")(
    "names what deleting would stop: a program, not a shell at its prompt",
    async () => {
      const terminals = service();
      const draft = draftRequest();
      ptySpawn
        .mockReturnValueOnce(fakePty("-system"))
        .mockReturnValueOnce(fakePty("python3"));
      await terminals.startSession({ ...draft, terminalId: "idle" });
      await terminals.startSession({ ...draft, terminalId: "server" });

      expect(terminals.stoppable(() => true)).toEqual([
        {
          key: draft.conversationKey,
          terminalId: "server",
          program: "python3",
        },
      ]);
      expect(terminals.stoppable(() => false)).toEqual([]);
    }
  );

  it("on Windows, which can't tell a program from a prompt, names every open terminal", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const terminals = service();
      const draft = draftRequest();
      await terminals.startSession({ ...draft, terminalId: "idle" });
      expect(terminals.stoppable(() => true)).toEqual([
        { key: draft.conversationKey, terminalId: "idle", program: null },
      ]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("ends a deleted chat's shells, those its new-chat page left too", async () => {
    const terminals = service();
    const drafted = fakePty();
    const chat = fakePty();
    const other = fakePty();
    ptySpawn
      .mockReturnValueOnce(drafted)
      .mockReturnValueOnce(chat)
      .mockReturnValueOnce(other);
    const draftRef = draftConversationRef("workspace-1", "chat-1");
    const chatRef = sessionConversationRef("workspace-1", "chat-1");
    const otherRef = sessionConversationRef("workspace-1", "chat-2");
    for (const conversation of [draftRef, chatRef, otherRef])
      await terminals.startSession({
        conversation,
        conversationKey: conversationKey(conversation),
        generation: null,
        cols: 80,
        rows: 24,
      });

    terminals.disposeConversation("workspace-1", "chat-1");
    expect(drafted.kill).toHaveBeenCalledOnce();
    expect(chat.kill).toHaveBeenCalledOnce();
    expect(other.kill).not.toHaveBeenCalled();

    terminals.disposeWorkspace("workspace-1");
    expect(other.kill).toHaveBeenCalledOnce();
    expect(terminals.hasLiveSessions()).toBe(false);
  });

  it("closes by key, a tab's shell or all of a conversation's, with no generation", async () => {
    const terminals = service();
    const ptys = [fakePty(), fakePty(), fakePty()];
    for (const pty of ptys) ptySpawn.mockReturnValueOnce(pty);
    const draft = draftRequest();
    await terminals.startSession({ ...draft, terminalId: "a" });
    await terminals.startSession({ ...draft, terminalId: "b" });
    await terminals.startSession({ ...draft, terminalId: "c" });
    expect(terminals.close(draft.conversationKey, "a")).toBe(true);
    expect(ptys[0]!.kill).toHaveBeenCalledOnce();
    expect(ptys[1]!.kill).not.toHaveBeenCalled();
    expect(terminals.close(draft.conversationKey)).toBe(true);
    expect(ptys[1]!.kill).toHaveBeenCalledOnce();
    expect(ptys[2]!.kill).toHaveBeenCalledOnce();
    expect(terminals.hasLiveSessions()).toBe(false);
  });

  it("answers a start for a shell that already ended with a quiet code, not a failure", async () => {
    const terminals = service();
    const draft = draftRequest();
    const { state } = await terminals.startSession(draft);
    terminals.close(draft.conversationKey);
    const stale = await terminals.startSession({
      ...draft,
      generation: state.generation,
    });
    expect(stale).toMatchObject({ success: false, error: "generation-stale" });
  });
});
