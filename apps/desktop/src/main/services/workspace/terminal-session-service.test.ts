import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  conversationKey,
  draftConversationRef,
  sessionConversationRef,
} from "#shared/conversation-scope";
import type { TerminalShellId } from "#shared/terminal-shells";

import { TerminalSessionService } from "./terminal-session-service";

const ptySpawn = vi.fn();
const storedShell = vi.fn<() => TerminalShellId>(() => "system");
const resolveShell = vi.fn((id: TerminalShellId) => ({
  id,
  file: `/bin/${id}`,
  args: ["-l"],
  env: id === "busybox" ? { BB_OVERRIDE_APPLETS: ";tar" } : undefined,
}));

vi.mock("../config/settings", () => ({
  readTerminalShell: () => storedShell(),
}));

vi.mock("./terminal-shells", () => ({
  resolveTerminalShell: (id: TerminalShellId) => resolveShell(id),
}));

vi.mock("zigpty", () => ({
  spawn: (...args: unknown[]) => ptySpawn(...args) as unknown,
}));

const fakePty = () => ({
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
  const conversation = draftConversationRef("workspace-1");
  return {
    conversation,
    conversationKey: conversationKey(conversation),
    generation: null,
    cols: 80,
    rows: 24,
  };
};

describe("conversation terminal session service", () => {
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
      pipe: process.platform === "win32",
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

  it("restarts a promoted draft in the session worktree", async () => {
    const worktree = path.join(workspace, "managed-chat");
    const terminals = new TerminalSessionService({
      resolveWorkspacePath: (_workspaceId, sessionId) =>
        sessionId == null ? workspace : worktree,
      emitTerminalOutput: () => {},
      emitTerminalExit: () => {},
      emitTerminalState: () => {},
    });
    const draft = draftRequest();
    await terminals.startSession(draft);
    const sessionConversation = sessionConversationRef("workspace-1", "saved");

    const promoted = await terminals.promoteDraftToSession({
      draftConversationKey: draft.conversationKey,
      draftConversation: draft.conversation,
      sessionConversationKey: conversationKey(sessionConversation),
      sessionConversation,
    });

    expect(promoted?.conversation).toEqual(sessionConversation);
    expect(ptySpawn).toHaveBeenCalledTimes(2);
    expect(ptySpawn.mock.calls[1]?.[2]).toMatchObject({ cwd: worktree });
    expect(ptySpawn.mock.results[0]?.value.kill).toHaveBeenCalledOnce();
  });
});
