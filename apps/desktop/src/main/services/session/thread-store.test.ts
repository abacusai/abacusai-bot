/**
 * C-T7: the thread store and the transition dual-write (spec 00 C.3).
 * - A v1 write produces the matching v2 twin; an `agui` twin is never
 *   overwritten, by the dual-write or by the repair.
 * - A failing v2 write does not stop `onPersist`, and the next
 *   `readCurrent` repairs the stale twin.
 * - `TranscriptService.remove` deletes both files.
 * - Through the real `ServiceHost` methods: a reset (the legacy IPC's
 *   `resetAgentConversation` and the new `agent.reset` procedure) leaves
 *   `ai.hydrate` empty, and a session delete and a workspace delete remove
 *   both files.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
  // ServiceHost's module graph touches many Electron members at import and
  // construction; none of them is exercised here.
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

import { v1ToThreadFile } from "#shared/transcript/thread-file";

import { connectInProcess, fakeDeps } from "../../rpc/testing";
import { ThreadStore } from "./thread-store";
import { TranscriptService } from "./transcript-service";

const SEGMENTS = [
  { type: "text", id: "u1", source: "user", content: "hello", at: 1 },
  { type: "text", id: "b1", source: "bot", content: "hi", at: 2 },
];
const MORE = [
  ...SEGMENTS,
  { type: "text", id: "u2", source: "user", content: "again", at: 3 },
];

let root: string;
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "thread-store-"));
  home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  previousHome = process.env.ABACUSAI_BOT_HOME;
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.chmodSync(root, 0o700);
  const threads = path.join(home, "threads");
  if (fs.existsSync(threads)) fs.chmodSync(threads, 0o700);
  fs.rmSync(root, { recursive: true, force: true });
});

const v1File = (id: string) => path.join(home, "transcripts", `${id}.json`);
const v2File = (id: string) => path.join(home, "threads", `${id}.json`);
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

const aguiThread = (id: string) => ({
  version: 2,
  threadId: id,
  updatedAt: "2030-01-01T00:00:00.000Z",
  source: { kind: "agui" },
  messages: [{ id: "m1", role: "assistant", parts: [] }],
  runs: [],
});

const silent = () => undefined;

describe("C-T7 thread store", () => {
  it("a dual-write produces the matching v2 twin", () => {
    const threads = new ThreadStore({ log: silent });
    const transcripts = new TranscriptService({ threads });
    transcripts.write("s1", SEGMENTS);

    const v1 = readJson(v1File("s1"));
    expect(readJson(v2File("s1"))).toEqual(
      JSON.parse(
        JSON.stringify(
          v1ToThreadFile({
            threadId: "s1",
            updatedAt: v1.updatedAt,
            segments: v1.segments,
          })
        )
      )
    );
    // Current: the repair has nothing to do.
    const before = fs.statSync(v2File("s1")).mtimeMs;
    expect(threads.readCurrentFile("s1")?.source).toEqual({
      kind: "transcript-v1",
      updatedAt: v1.updatedAt,
      segments: 2,
    });
    expect(fs.statSync(v2File("s1")).mtimeMs).toBe(before);
  });

  it("never overwrites an agui twin", async () => {
    const threads = new ThreadStore({ log: silent });
    fs.mkdirSync(path.dirname(v2File("s1")), { recursive: true });
    const agui = JSON.stringify(aguiThread("s1"));
    fs.writeFileSync(v2File("s1"), agui);

    new TranscriptService({ threads }).write("s1", MORE);
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(agui);
    expect(await threads.readCurrent("s1")).toEqual(aguiThread("s1").messages);
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(agui);
  });

  it("keeps onPersist when the v2 write fails, and repairs the stale twin on read", async () => {
    const threads = new ThreadStore({ log: silent });
    const transcripts = new TranscriptService({ threads });
    const persisted: string[] = [];
    transcripts.setOnPersist((id) => persisted.push(id));
    const errors = vi.spyOn(console, "error").mockImplementation(silent);

    transcripts.write("s1", SEGMENTS);
    const stale = fs.readFileSync(v2File("s1"), "utf8");
    // The threads folder turns read-only: the next dual-write fails.
    fs.chmodSync(path.join(home, "threads"), 0o500);
    await new Promise((resolve) => setTimeout(resolve, 5));
    transcripts.write("s1", MORE);
    expect(persisted).toEqual(["s1", "s1"]);
    expect(errors).toHaveBeenCalledWith(
      "[transcripts] failed to write the v2 thread",
      expect.anything()
    );
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(stale);
    fs.chmodSync(path.join(home, "threads"), 0o700);
    errors.mockRestore();

    const messages = await threads.readCurrent("s1");
    expect(messages.map((message) => message.id)).toEqual(["u1", "b1", "u2"]);
    const repaired = readJson(v2File("s1"));
    expect(repaired.source.updatedAt).toBe(readJson(v1File("s1")).updatedAt);
    expect(repaired.source.segments).toBe(3);
  });

  it("repairs a missing or unparseable twin, and never revives a cleared one", async () => {
    const threads = new ThreadStore({ log: silent });
    new TranscriptService().write("s1", SEGMENTS);
    expect(fs.existsSync(v2File("s1"))).toBe(false);
    expect((await threads.readCurrent("s1")).length).toBe(2);
    expect(fs.existsSync(v2File("s1"))).toBe(true);

    fs.writeFileSync(v2File("s1"), "{half");
    expect((await threads.readCurrent("s1")).length).toBe(2);
    expect(readJson(v2File("s1")).version).toBe(2);

    // The v1 file is gone (cleared) but its v1-derived twin survived.
    fs.rmSync(v1File("s1"));
    expect(await threads.readCurrent("s1")).toEqual([]);
    expect(await threads.readCurrent("../escape")).toEqual([]);
  });

  it("TranscriptService.remove deletes both files", () => {
    const threads = new ThreadStore({ log: silent });
    const transcripts = new TranscriptService({ threads });
    transcripts.write("s1", SEGMENTS);
    expect(fs.existsSync(v2File("s1"))).toBe(true);
    transcripts.remove("s1");
    expect(fs.existsSync(v1File("s1"))).toBe(false);
    expect(fs.existsSync(v2File("s1"))).toBe(false);
  });
});

describe("C-T7 through ServiceHost", () => {
  /** The real ServiceHost, with the collaborators the paths call faked. */
  const makeHost = async () => {
    const { ServiceHost } = await import("../../service-host");
    const host = new ServiceHost();
    const internals = host as unknown as Record<string, unknown>;
    internals.agentCommunicationService = { resetConversation: vi.fn() };
    internals.agentManagerService = { stopSession: vi.fn() };
    internals.agentSessionManagerService = {
      remove: () => true,
      removeAllForWorkspace: () => ["s1", "s2"],
    };
    internals.sessionArtifactsService = {
      removeForSession: vi.fn(),
      removeForWorkspace: vi.fn(),
    };
    internals.sessionTurnStateService = { clearSession: vi.fn() };
    internals.messagingGatewayService = { forgetSession: vi.fn() };
    internals.workspaceService = {
      getWorkspaces: () => [{ id: "w1", status: "deleted" }],
      removeWorkspace: vi.fn(),
    };
    internals.workspaceRuntimeService = {
      ensureWorkspaceWatchers: vi.fn(),
      refreshAndEmit: vi.fn(async () => undefined),
    };
    internals.emitEvent = vi.fn();
    return host;
  };

  const seed = (host: { writeTranscript(id: string, s: never[]): void }) => {
    for (const id of ["s1", "s2"])
      host.writeTranscript(id, SEGMENTS as never[]);
  };

  it("wires the thread store into the transcript dual-write", async () => {
    const host = await makeHost();
    const internals = host as unknown as Record<string, unknown>;
    expect(
      (internals.transcriptService as Record<string, unknown>).threads
    ).toBe(host.threadStore);
  }, 30_000);

  it("a reset through the legacy call and through agent.reset leaves ai.hydrate empty", async () => {
    const host = await makeHost();
    seed(host);
    const connection = connectInProcess(
      fakeDeps({
        serviceHost: {
          resetAgentConversation: (request: never) =>
            host.resetAgentConversation(request),
        },
        // The real relay: hydrate reads the thread store through it.
        ai: host.aguiRelay,
        threads: host.threadStore,
      })
    );
    try {
      const hydrate = (threadId: string) =>
        connection.client.ai.hydrate({ threadId });
      expect((await hydrate("s1")).messages).toHaveLength(2);
      expect((await hydrate("s2")).messages).toHaveLength(2);

      // The legacy IPC handler calls this method directly.
      host.resetAgentConversation({ workspaceId: "w1", sessionId: "s1" });
      await connection.client.agent.reset({
        workspaceId: "w1",
        sessionId: "s2",
      });

      expect((await hydrate("s1")).messages).toEqual([]);
      expect((await hydrate("s2")).messages).toEqual([]);
      for (const id of ["s1", "s2"]) {
        expect(fs.existsSync(v1File(id))).toBe(false);
        expect(fs.existsSync(v2File(id))).toBe(false);
      }
    } finally {
      connection.closeClient();
      connection.closeServer();
    }
  }, 30_000);

  it("a session delete and a workspace delete remove both files", async () => {
    const host = await makeHost();
    seed(host);
    host.writeTranscript("s3", SEGMENTS as never[]);

    expect(host.removeAgentSession("w1", "s3")).toBe(true);
    expect(fs.existsSync(v1File("s3"))).toBe(false);
    expect(fs.existsSync(v2File("s3"))).toBe(false);

    await expect(host.removeWorkspace("w1")).resolves.toEqual({
      success: true,
    });
    for (const id of ["s1", "s2"]) {
      expect(fs.existsSync(v1File(id))).toBe(false);
      expect(fs.existsSync(v2File(id))).toBe(false);
    }
  }, 30_000);
});
