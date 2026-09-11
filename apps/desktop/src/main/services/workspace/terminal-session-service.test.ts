import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  conversationKey,
  draftConversationRef,
  sessionConversationRef,
} from "#shared/conversation-scope";

import { TerminalSessionService } from "./terminal-session-service";

const ptySpawn = vi.fn();

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
