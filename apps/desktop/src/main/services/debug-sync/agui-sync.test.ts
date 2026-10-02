/**
 * Spec 03 §24.12 (R3-T19/R3-T28 main case): a new AG-UI-only bot thread,
 * never saved by the legacy renderer (no v1 transcript), uploads its
 * messages keyed by message id, accepts feedback on a live message id with
 * the uploaded `event_sequence_number`, and updates its sidebar preview,
 * all triggered by the relay's `writeAgui`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "1.0.0", userAgentFallback: "" },
}));
vi.mock("../config/settings", () => ({
  readSettings: () => ({ apiKeys: { ABACUS_API_KEY: "abacus-key" } }),
}));
vi.mock("../diagnostics/client-environment", () => ({
  clientEnvironment: () => ({ os_name: "macOS", platform: "darwin" }),
}));
vi.mock("./device-id", () => ({ deviceId: () => "device-1" }));

const { AguiRelayService } = await import("../agui/relay-service");
const { botChatPreview } = await import("../bots/bot-chat-preview");
const { ThreadStore } = await import("../session/thread-store");
const { TranscriptService } = await import("../session/transcript-service");
const { DebugSyncService } = await import("./debug-sync-service");
const { FeedbackService } = await import("./feedback-service");
const { AGUI_ENTRY_TYPE, syncLogFor } = await import("./sync-log");

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agui-sync-"));
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUSAI_BOT_DEBUG_SYNC_URL = "https://sync.test/debug";
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.ABACUSAI_BOT_DEBUG_SYNC_URL;
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const SESSION = "sess-agui-1";

describe("debug sync, feedback and previews on v2 AG-UI threads", () => {
  it("uploads a never-saved AG-UI bot thread, rates a live message id, and previews it", async () => {
    const store = new ThreadStore({ home: () => home, log: () => undefined });
    const transcripts = new TranscriptService({ threads: store });
    const debugSync = new DebugSyncService({
      readTranscript: (id) =>
        syncLogFor(id, {
          readV1: (sessionId) => transcripts.read(sessionId),
          readThread: (sessionId) => store.readAguiFile(sessionId),
        }),
      clientVersion: "1.0.0",
    });
    const uploads: Array<{ events: Array<Record<string, unknown>> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        uploads.push(JSON.parse(String(init.body)));
        return new Response("{}", { status: 200 });
      })
    );
    const posted: Array<Record<string, unknown>> = [];
    const feedback = new FeedbackService({
      debugSync,
      clientVersion: "1.0.0",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        posted.push(JSON.parse(String(init.body)));
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    // As ServiceHost wires it: writeAgui is the bot session's persist.
    const persisted: string[] = [];
    store.onAguiPersist((sessionId) => {
      persisted.push(sessionId);
      debugSync.enqueue(sessionId);
    });

    const runtime = {};
    const relay = new AguiRelayService({
      host: {
        workspaceOf: () => "w1",
        runtime: () => ({ wire: "agui", status: "running" }),
        start: async () => true,
        send: () => runtime,
        markSent: () => undefined,
        markStopped: () => undefined,
      },
      files: store,
      aguiForEverySpawn: true,
      log: () => undefined,
    });
    const emit = (event: Record<string, unknown>) =>
      relay.ingest(SESSION, event, { wire: "agui", runtime });
    emit({
      type: "CUSTOM",
      name: "wire.hello",
      value: { protocol: 1, wire: "agui", compat: "fd", incarnation: "i1" },
    });
    emit({ type: "RUN_STARTED", threadId: SESSION, runId: "run-1" });
    for (const [messageId, role, content] of [
      ["run-1:u", "user", "What's next?"],
      ["run-1:a", "assistant", "I checked three repos.\n\nShall I open a PR?"],
    ] as const) {
      emit({ type: "TEXT_MESSAGE_START", messageId, role });
      emit({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: content });
      emit({ type: "TEXT_MESSAGE_END", messageId });
    }
    emit({
      type: "RUN_FINISHED",
      threadId: SESSION,
      runId: "run-1",
      outcome: { type: "success" },
    });

    // No v1 transcript was ever written.
    expect(transcripts.read(SESSION)).toBeNull();
    expect(store.readCurrentFile(SESSION)?.source.kind).toBe("agui");
    expect(persisted).toEqual([SESSION]);

    // The sidebar preview comes from the v2 file.
    const preview = botChatPreview(transcripts, SESSION, store);
    expect(preview?.text).toBe("Shall I open a PR?");

    // Feedback flushes the sync, then posts the message's uploaded sequence.
    const outcome = await feedback.submit({
      sessionId: SESSION,
      segmentId: "run-1:a",
      rating: "up",
    });
    expect(outcome).toEqual({ ok: true });
    expect(uploads).toHaveLength(1);
    const events = uploads[0]!.events;
    expect(
      events.map((event) => [
        event.event_sequence_number,
        (event.segment as { id: string }).id,
        (event.segment as { type: string }).type,
      ])
    ).toEqual([
      [0, "run-1:u", AGUI_ENTRY_TYPE],
      [1, "run-1:a", AGUI_ENTRY_TYPE],
    ]);
    expect(events[1]!.segment).toMatchObject({
      messageId: "run-1:a",
      role: "assistant",
      partIndex: 0,
      part: { type: "text" },
    });
    expect(posted[0]).toMatchObject({
      session_id: SESSION,
      event_sequence_number: 1,
      rating: "up",
    });
    expect(debugSync.sequenceOf(SESSION, "run-1:a")).toBe(1);

    // A second run appends; nothing already uploaded is sent again.
    emit({ type: "RUN_STARTED", threadId: SESSION, runId: "run-2" });
    emit({
      type: "TEXT_MESSAGE_START",
      messageId: "run-2:a",
      role: "assistant",
    });
    emit({
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "run-2:a",
      delta: "Opened #12.",
    });
    emit({ type: "TEXT_MESSAGE_END", messageId: "run-2:a" });
    emit({
      type: "RUN_FINISHED",
      threadId: SESSION,
      runId: "run-2",
      outcome: { type: "success" },
    });
    await debugSync.flush(SESSION);
    expect(
      uploads[1]!.events.map((event) => [
        event.event_sequence_number,
        (event.segment as { id: string }).id,
      ])
    ).toEqual([[2, "run-2:a"]]);
    expect(botChatPreview(transcripts, SESSION, store)?.text).toBe(
      "Opened #12."
    );
  });

  it("keys multi-part messages by id then id#index, and skips messages migrated from v1", () => {
    const log = syncLogFor("s", {
      readV1: () => ({
        version: 1,
        sessionId: "s",
        updatedAt: "",
        segments: [{ id: "text:0:1", type: "text", content: "old" }],
      }),
      readThread: () => ({
        source: { kind: "agui" },
        messages: [
          {
            id: "m-old",
            role: "assistant",
            parts: [{ type: "text", content: "old" }],
            metadata: { abacus: { segments: [{ id: "text:0:1" }] } },
          },
          {
            id: "run-3:a",
            role: "assistant",
            parts: [
              { type: "text", content: "a" },
              { type: "tool-call", id: "t1" },
            ],
          },
        ],
      }),
    });
    expect(
      log?.segments.map((segment) => (segment as { id: string }).id)
    ).toEqual(["text:0:1", "run-3:a", "run-3:a#1"]);
  });
});

it("debug-sync reads v1 history without creating or repairing its v2 twin", () => {
  const store = new ThreadStore({ home: () => home, log: () => undefined });
  const transcripts = new TranscriptService({ threads: store });
  fs.mkdirSync(path.join(home, "transcripts"), { recursive: true });
  const file = path.join(home, "transcripts", "legacy.json");
  const bytes = JSON.stringify({
    version: 1,
    sessionId: "legacy",
    updatedAt: "2026-09-01T00:00:00Z",
    segments: [{ id: "u", type: "text", source: "user", content: "hi" }],
  });
  fs.writeFileSync(file, bytes);
  const result = syncLogFor("legacy", {
    readV1: (id) => transcripts.read(id),
    readThread: (id) => store.readAguiFile(id),
  });
  expect(result?.segments).toHaveLength(1);
  expect(fs.existsSync(store.threadPath("legacy")!)).toBe(false);
  expect(fs.readFileSync(file, "utf8")).toBe(bytes);
});
