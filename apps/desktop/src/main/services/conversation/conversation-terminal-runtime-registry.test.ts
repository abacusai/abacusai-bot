import { describe, expect, it, vi, type Mock } from "vitest";

import {
  conversationKey,
  type ConversationScope,
  type DraftConversationScope,
  type SessionConversationScope,
} from "./conversation-key";
import {
  BoundedScrollback,
  ConversationTerminalRuntimeRegistry,
  type TerminalPty,
} from "./conversation-terminal-runtime-registry";

type FakePty = TerminalPty & {
  emitData: (data: string) => void;
  emitExit: (exitCode: number, signal?: number | null) => void;
  write: Mock<(data: string) => void>;
  resize: Mock<(cols: number, rows: number) => void>;
  kill: Mock<(signal?: string) => void>;
};

const fakePty = (): FakePty => {
  let dataListener: (data: string) => void = () => {};
  let exitListener: (event: {
    exitCode: number;
    signal?: number | null;
  }) => void = () => {};
  return {
    onData: vi.fn((listener: (data: string) => void) => {
      dataListener = listener;
    }),
    onExit: vi.fn(
      (
        listener: (event: { exitCode: number; signal?: number | null }) => void
      ) => {
        exitListener = listener;
      }
    ),
    write: vi.fn<(data: string) => void>(),
    resize: vi.fn<(cols: number, rows: number) => void>(),
    kill: vi.fn<(signal?: string) => void>(),
    emitData: (data) => dataListener(data),
    emitExit: (exitCode, signal) => exitListener({ exitCode, signal }),
  };
};

const draft = (workspaceId: string): DraftConversationScope => ({
  workspaceId,
  kind: "draft",
});

const session = (
  workspaceId: string,
  sessionId: string
): SessionConversationScope => ({ workspaceId, kind: "session", sessionId });

const setup = (maximumBytes = 1024) => {
  const ptys: FakePty[] = [];
  const output = vi.fn();
  const exit = vi.fn();
  const registry = new ConversationTerminalRuntimeRegistry({
    maxScrollbackBytes: maximumBytes,
    createPty: () => {
      const pty = fakePty();
      ptys.push(pty);
      return pty;
    },
    onOutput: output,
    onExit: exit,
  });
  return { registry, ptys, output, exit };
};

describe("conversation terminal runtime registry", () => {
  it("keeps draft and persisted-session terminals independent", async () => {
    const { registry, ptys } = setup();
    const draftResult = await registry.start({
      scope: draft("workspace-1"),
      cols: 80,
      rows: 24,
    });
    const sessionResult = await registry.start({
      scope: session("workspace-1", "session-1"),
      cols: 100,
      rows: 30,
    });

    expect(ptys).toHaveLength(2);
    expect(draftResult.key).not.toBe(sessionResult.key);
    expect(draftResult.generation).toBe(1);
    expect(sessionResult.generation).toBe(1);
  });

  it("keeps terminal tabs independent within one conversation", async () => {
    const { registry, ptys, output } = setup();
    const scope = draft("workspace-1");
    const first = await registry.start({
      terminalId: "first",
      scope,
      cols: 80,
      rows: 24,
    });
    const second = await registry.start({
      terminalId: "second",
      scope,
      cols: 100,
      rows: 30,
    });

    expect(ptys).toHaveLength(2);
    expect(
      registry.list(first.key).map(({ terminalId }) => terminalId)
    ).toEqual(["first", "second"]);
    expect(registry.write(first.key, first.generation, "one", "first")).toBe(
      true
    );
    expect(registry.write(second.key, second.generation, "two", "second")).toBe(
      true
    );
    expect(ptys[0]!.write).toHaveBeenCalledWith("one");
    expect(ptys[1]!.write).toHaveBeenCalledWith("two");

    ptys[1]!.emitData("second output");
    expect(output).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: "second", data: "second output" })
    );
    expect(registry.close(first.key, first.generation, "first")).toBe(true);
    expect(
      registry.attach(second.key, second.generation, "second")
    ).not.toBeNull();
  });

  it("hides without killing and returns bounded scrollback when attached", async () => {
    const { registry, ptys } = setup(8);
    const result = await registry.start({
      scope: draft("workspace-1"),
      cols: 80,
      rows: 24,
    });
    ptys[0]!.emitData("hello ");
    ptys[0]!.emitData("world");

    expect(registry.hide(result.key, result.generation)).toBe(true);
    expect(ptys[0]!.kill).not.toHaveBeenCalled();
    expect(registry.attach(result.key, result.generation)).toMatchObject({
      visible: true,
      scrollback: "lo world",
    });
  });

  it("keeps UTF-8 scrollback valid when trimming", () => {
    const scrollback = new BoundedScrollback(6);
    scrollback.append("a🙂b");
    scrollback.append("c");
    expect(scrollback.read()).toBe("🙂bc");
  });

  it("requires the current generation for writes, resizes, and hides", async () => {
    const { registry, ptys } = setup();
    const result = await registry.start({
      scope: draft("workspace-1"),
      cols: 80,
      rows: 24,
    });

    expect(registry.write(result.key, result.generation - 1, "stale")).toBe(
      false
    );
    expect(registry.resize(result.key, result.generation - 1, 90, 28)).toBe(
      false
    );
    expect(registry.hide(result.key, result.generation - 1)).toBe(false);
    expect(registry.write(result.key, result.generation, "current")).toBe(true);
    expect(registry.resize(result.key, result.generation, 90, 28)).toBe(true);
    expect(ptys[0]!.write).toHaveBeenCalledWith("current");
    expect(ptys[0]!.resize).toHaveBeenCalledWith(90, 28);
  });

  it("kills on explicit close and rejects callbacks from the old runtime", async () => {
    const { registry, ptys, output, exit } = setup();
    const scope = draft("workspace-1");
    const first = await registry.start({ scope, cols: 80, rows: 24 });
    expect(registry.close(first.key, first.generation)).toBe(true);
    expect(ptys[0]!.kill).toHaveBeenCalledOnce();

    const second = await registry.start({ scope, cols: 80, rows: 24 });
    expect(second.generation).toBeGreaterThan(first.generation);
    ptys[0]!.emitData("old output");
    ptys[0]!.emitExit(0);

    expect(output).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(registry.attach(second.key, second.generation)).not.toBeNull();
  });

  it("promotes the same PTY and scrollback from draft to session once", async () => {
    const { registry, ptys } = setup();
    const draftScope = draft("workspace-1");
    const sessionScope = session("workspace-1", "session-1");
    const started = await registry.start({
      scope: draftScope,
      cols: 80,
      rows: 24,
    });
    ptys[0]!.emitData("preserved");

    const promoted = await registry.promoteDraftToSession(
      draftScope,
      sessionScope
    );
    expect(promoted.status).toBe("promoted");
    expect(promoted.attachment).toMatchObject({
      key: conversationKey(sessionScope),
      scrollback: "preserved",
    });
    expect(promoted.attachment!.generation).toBeGreaterThan(started.generation);
    expect(registry.attach(conversationKey(draftScope))).toBeNull();
    expect(ptys).toHaveLength(1);

    registry.hide(promoted.attachment!.key, promoted.attachment!.generation);
    const repeated = await registry.promoteDraftToSession(
      draftScope,
      sessionScope
    );
    expect(repeated.status).toBe("already-promoted");
    expect(repeated.attachment?.visible).toBe(false);

    await registry.start({ scope: draftScope, cols: 90, rows: 30 });
    expect(ptys).toHaveLength(2);
    expect(registry.attach(conversationKey(sessionScope))?.scrollback).toBe(
      "preserved"
    );
  });

  it("disposes one scope, one workspace, or every workspace", async () => {
    const { registry, ptys } = setup();
    const scopes: ConversationScope[] = [
      draft("workspace-1"),
      session("workspace-1", "session-1"),
      draft("workspace-2"),
    ];
    const started = await Promise.all(
      scopes.map((scope) => registry.start({ scope, cols: 80, rows: 24 }))
    );

    expect(registry.disposeScope(started[0]!.key)).toBe(true);
    expect(registry.disposeWorkspace("workspace-1")).toBe(1);
    expect(registry.attach(started[2]!.key)).not.toBeNull();
    expect(registry.disposeAll()).toBe(1);
    expect(ptys.map((pty) => pty.kill.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("cancels a pending start during disposal", async () => {
    const pty = fakePty();
    let resolvePty: ((value: TerminalPty) => void) | undefined;
    const registry = new ConversationTerminalRuntimeRegistry({
      createPty: () =>
        new Promise<TerminalPty>((resolve) => {
          resolvePty = resolve;
        }),
    });
    const scope = draft("workspace-1");
    const starting = registry.start({ scope, cols: 80, rows: 24 });

    expect(registry.disposeWorkspace("workspace-1")).toBe(1);
    resolvePty!(pty);
    await expect(starting).rejects.toThrow("superseded");
    expect(pty.kill).toHaveBeenCalledOnce();
  });
});
