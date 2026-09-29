/**
 * Restoring a transcript from disk.
 *
 * The case that broke: a bot's routine chat is minted before its first fire,
 * and the sidebar warms it on hover. The first read found no file, the session
 * was written off as restored for the rest of the run, and every fire after
 * that wrote a transcript nothing would ever load: a blank chat sitting next
 * to a file with the whole conversation in it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  forgetTranscript,
  restoreTranscript,
  startTranscriptPersistence,
} from "./persistence";
import { workspaceConversationTransport } from "./transport";

const readTranscript = vi.fn();
const writeTranscript = vi.fn(
  async (_sessionId: string, _segments: unknown[]) => undefined
);
/** The persistence subscriber, as the transport would call it on an event. */
let onEvent: (sessionId: string | null) => void = () => {};

/** What the store holds, as `startTranscriptPersistence` reads it. */
let stored: Record<string, unknown[]> = {};

const hydrations = (): unknown[][] => emitted;
let emitted: unknown[][] = [];

beforeEach(() => {
  vi.clearAllMocks();
  stored = {};
  emitted = [];
  forgetTranscript("chat-1");
  (window as unknown as { api: unknown }).api = {
    agent: { readTranscript, writeTranscript },
  };
  vi.spyOn(workspaceConversationTransport, "subscribe").mockImplementation(((
    listener: (sessionId: string | null) => void
  ) => {
    onEvent = listener;
    return () => {};
  }) as never);
  startTranscriptPersistence((sessionId) => (stored[sessionId] ?? []) as never);
  vi.spyOn(workspaceConversationTransport, "emit").mockImplementation(((
    sessionId: string,
    event: { kind?: string; segments?: unknown[] }
  ) => {
    if (event.kind === "hydrate") emitted.push(event.segments ?? []);
  }) as never);
});

const segment = { type: "text", id: "text:0:0", source: "bot", content: "hi" };

describe("restoreTranscript", () => {
  it("loads what is on disk and hydrates once", async () => {
    readTranscript.mockResolvedValue([segment]);

    await restoreTranscript("chat-1");
    await restoreTranscript("chat-1");

    expect(hydrations()).toHaveLength(1);
    expect(readTranscript).toHaveBeenCalledTimes(1);
  });

  it("tries again after an empty read, rather than writing the chat off", async () => {
    // The routine chat, opened before its first fire.
    readTranscript.mockResolvedValueOnce([]);
    await restoreTranscript("chat-1");

    expect(hydrations()).toEqual([]);

    // The routine fires and its transcript lands. Opening the chat now shows it.
    readTranscript.mockResolvedValue([segment]);
    await restoreTranscript("chat-1");

    expect(hydrations()).toHaveLength(1);
  });

  it("tries again after a failed read too", async () => {
    readTranscript.mockRejectedValueOnce(new Error("EBUSY"));
    await restoreTranscript("chat-1");

    readTranscript.mockResolvedValue([segment]);
    await restoreTranscript("chat-1");

    expect(hydrations()).toHaveLength(1);
  });

  it("shares one read between a prefetch and the open behind it", async () => {
    readTranscript.mockResolvedValue([segment]);

    await Promise.all([
      restoreTranscript("chat-1"),
      restoreTranscript("chat-1"),
    ]);

    expect(readTranscript).toHaveBeenCalledTimes(1);
    expect(hydrations()).toHaveLength(1);
  });

  it("puts the file underneath segments that arrived live, never skipping it", async () => {
    // The routine chat after a restart: the routine fired before anyone
    // opened the chat, so the store already holds that one turn. "Already
    // live, in-memory is newer" skipped the restore, and the chat showed
    // only the fire that had just landed.
    const live = {
      type: "text",
      id: "text:0:9",
      source: "bot",
      content: "now",
    };
    stored["chat-1"] = [live];
    readTranscript.mockResolvedValue([segment]);

    await restoreTranscript("chat-1");

    expect(readTranscript).toHaveBeenCalledTimes(1);
    expect(hydrations()).toHaveLength(1);
    const ids = (hydrations()[0] as { id: string }[]).map((s) => s.id);
    expect(ids).toEqual(["text:0:0", "text:0:9"]);
  });

  it("does not double a chat whose file already holds the live turns", async () => {
    // Open a bot, let it reply, leave, come back: the save wrote the reply to
    // disk in between, and the reopen reads it straight back. Every message
    // showed twice, the second copy with "#2" ids.
    const call = {
      type: "tool_call",
      id: "call_1",
      toolCall: { id: "call_1", name: "memory" },
    };
    const later = {
      type: "text",
      id: "text:0:5",
      source: "bot",
      content: "done",
    };
    stored["chat-1"] = [segment, call, later];
    readTranscript.mockResolvedValue([segment, call, later]);

    await restoreTranscript("chat-1");

    const ids = (hydrations()[0] as { id: string }[]).map((s) => s.id);
    expect(ids).toEqual(["text:0:0", "call_1", "text:0:5"]);
  });

  it("prefers the live copy of a segment the file also holds, and keeps what the file lacks", async () => {
    // The file was saved mid-stream; the store finished the sentence since.
    const streamed = { ...segment, content: "hi there" };
    const fresh = {
      type: "text",
      id: "text:0:9",
      source: "bot",
      content: "new",
    };
    stored["chat-1"] = [streamed, fresh];
    readTranscript.mockResolvedValue([
      { type: "text", id: "text:-1:0", source: "user", content: "hey" },
      segment,
    ]);

    await restoreTranscript("chat-1");

    const out = hydrations()[0] as { id: string; content: string }[];
    expect(out.map((s) => s.id)).toEqual(["text:-1:0", "text:0:0", "text:0:9"]);
    expect(out[1]!.content).toBe("hi there");
  });
});

describe("a live event before the first open", () => {
  it("restores the file first, and the save that follows keeps all of it", async () => {
    vi.useFakeTimers();
    try {
      const live = {
        type: "text",
        id: "text:0:9",
        source: "bot",
        content: "now",
      };
      stored["chat-1"] = [live];
      readTranscript.mockResolvedValue([segment]);

      // The routine fires: one transport event, nobody has opened the chat.
      onEvent("chat-1");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(hydrations()).toHaveLength(1);
      // The file was read before the debounced save ran, so the save never
      // saw a one-turn transcript to write over the history with.
      expect(writeTranscript).toHaveBeenCalledTimes(1);
      const written = writeTranscript.mock.calls[0]?.[1] as { id: string }[];
      // What the store holds after the hydrate is what gets written; the
      // fake store here is static, so the point pinned is the ORDER: read,
      // then write, not write-then-read.
      expect(readTranscript.mock.invocationCallOrder[0]).toBeLessThan(
        writeTranscript.mock.invocationCallOrder[0]!
      );
      expect(written.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never writes while the file is unread", async () => {
    vi.useFakeTimers();
    try {
      stored["chat-1"] = [segment];
      readTranscript.mockRejectedValue(new Error("EBUSY"));

      onEvent("chat-1");
      await vi.advanceTimersByTimeAsync(1_000);

      // A read that fails leaves the file alone; nothing may shrink it.
      expect(writeTranscript).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
