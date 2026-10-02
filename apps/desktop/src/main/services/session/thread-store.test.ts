/**
 * C-T7: the thread store and the transition dual-write (spec 00 C.3).
 * - A v1 write produces the matching v2 twin (fingerprinted); the deferred
 *   dual-write coalesces saves and a read flushes it; an `agui` twin is
 *   never overwritten, by the dual-write or by the repair.
 * - A failing v2 write (an injected fs error, not a permission bit) does not
 *   stop `onPersist`, and the next `readCurrent` repairs the stale twin, also
 *   when both v1 saves share one millisecond (fixed clock).
 * - Never replaced: an unreadable twin, a newer build's twin; a v1 file that
 *   cannot be read or is over the size cap is not converted.
 * - Clearing: `TranscriptService.remove` deletes both files; a failed or
 *   interrupted removal leaves a clear marker, so neither a v1-derived nor an
 *   `agui` twin comes back, across a restart too, until new history is saved.
 * - Write blocks: hydration, save, reset and deletion against an unresolved
 *   migration attempt keep changes in memory and leave the files alone.
 * - Through the real `ServiceHost` methods: a reset (the legacy IPC's
 *   `resetAgentConversation` and the new `agent.reset` procedure) leaves
 *   `ai.hydrate` empty, and a session delete and a workspace delete remove
 *   both files.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";
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
import {
  LegacyTranscriptFixture as TranscriptService,
  type TranscriptServiceOptions,
} from "./legacy-transcript-fixture.test-support";
import {
  fingerprintV1,
  peeksAsDerivedV2,
  ThreadStore,
  type ThreadStoreOptions,
} from "./thread-store";

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
  vi.useRealTimers();
  if (previousHome === undefined) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

const v1File = (id: string) => path.join(home, "transcripts", `${id}.json`);
const v2File = (id: string) => path.join(home, "threads", `${id}.json`);
const markerFile = (id: string) => path.join(home, "threads", `${id}.cleared`);
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const put = (file: string, contents: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof contents === "string" ? contents : JSON.stringify(contents)
  );
};

const aguiThread = (id: string) => ({
  version: 2,
  threadId: id,
  updatedAt: "2030-01-01T00:00:00.000Z",
  source: { kind: "agui" },
  messages: [{ id: "m1", role: "assistant", parts: [] }],
  runs: [],
});

const silent = () => undefined;

/** A store and a transcript service sharing it, dual-writing at once. */
const make = (
  threadOptions: ThreadStoreOptions = {},
  transcriptOptions: TranscriptServiceOptions = {}
) => {
  const threads = new ThreadStore({
    log: silent,
    isWriteBlocked: () => false,
    ...threadOptions,
  });
  const transcripts = new TranscriptService({
    threads,
    isWriteBlocked: () => false,
    ...transcriptOptions,
  });
  return { threads, transcripts };
};

const ids = (messages: Array<{ id: string }>) =>
  messages.map((message) => message.id);

describe("C-T7 thread store", () => {
  it("a dual-write produces the matching, fingerprinted v2 twin", () => {
    const { threads, transcripts } = make();
    transcripts.write("s1", SEGMENTS);

    const text = fs.readFileSync(v1File("s1"), "utf8");
    const v1 = JSON.parse(text);
    expect(readJson(v2File("s1"))).toEqual(
      JSON.parse(
        JSON.stringify(
          v1ToThreadFile({
            threadId: "s1",
            updatedAt: v1.updatedAt,
            segments: v1.segments,
            fingerprint: fingerprintV1(text),
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
      fingerprint: fingerprintV1(text),
    });
    expect(fs.statSync(v2File("s1")).mtimeMs).toBe(before);
  });

  it("never overwrites an agui twin", async () => {
    const { threads, transcripts } = make();
    const agui = JSON.stringify(aguiThread("s1"));
    put(v2File("s1"), agui);

    transcripts.write("s1", MORE);
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(agui);
    expect(await threads.readCurrent("s1")).toEqual(aguiThread("s1").messages);
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(agui);
  });

  it("keeps onPersist when the v2 write fails, and repairs the stale twin on read", async () => {
    let failThreads = false;
    const { threads, transcripts } = make({
      writeFile: (file, text) => {
        if (failThreads)
          throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        writeFileAtomicSync(file, text);
      },
    });
    const persisted: string[] = [];
    transcripts.setOnPersist((id) => persisted.push(id));
    const errors = vi.spyOn(console, "error").mockImplementation(silent);

    transcripts.write("s1", SEGMENTS);
    const stale = fs.readFileSync(v2File("s1"), "utf8");
    failThreads = true;
    transcripts.write("s1", MORE);
    expect(persisted).toEqual(["s1", "s1"]);

    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(stale);
    failThreads = false;
    errors.mockRestore();

    expect(ids(await threads.readCurrent("s1"))).toEqual(["u1", "b1", "u2"]);
    const repaired = readJson(v2File("s1"));
    expect(repaired.source.updatedAt).toBe(readJson(v1File("s1")).updatedAt);
    expect(repaired.source.segments).toBe(3);
  });

  it("repairs a stale twin when both v1 saves share one millisecond", async () => {
    const clock = new Date("2026-09-01T10:00:00.000Z");
    let failThreads = false;
    const { threads, transcripts } = make(
      {
        writeFile: (file, text) => {
          if (failThreads) throw new Error("boom");
          writeFileAtomicSync(file, text);
        },
      },
      { now: () => clock }
    );
    vi.spyOn(console, "error").mockImplementation(silent);
    transcripts.write("s1", SEGMENTS);
    failThreads = true;
    transcripts.write("s1", MORE);
    failThreads = false;
    vi.restoreAllMocks();
    // Same `updatedAt` on both sides; only the fingerprint tells them apart.
    expect(readJson(v2File("s1")).source.updatedAt).toBe(
      readJson(v1File("s1")).updatedAt
    );
    expect(ids(await threads.readCurrent("s1"))).toEqual(["u1", "b1", "u2"]);
  });

  it("repairs a missing or unparseable twin, and treats a twin without v1 as cleared", async () => {
    const threads = new ThreadStore({
      log: silent,
      isWriteBlocked: () => false,
    });
    new TranscriptService({ isWriteBlocked: () => false }).write(
      "s1",
      SEGMENTS
    );
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

  it("never replaces a twin it cannot read, and serves v1 instead", async () => {
    const { threads, transcripts } = make();
    // A directory where the file should be: EISDIR, not ENOENT.
    fs.mkdirSync(v2File("s1"), { recursive: true });
    transcripts.write("s1", SEGMENTS);
    expect(ids(await threads.readCurrent("s1"))).toEqual(["u1", "b1"]);
    expect(fs.statSync(v2File("s1")).isDirectory()).toBe(true);
  });

  it("serves the twin as is when the v1 file cannot be read or is too large", async () => {
    // Past both bounds: not even streamed.
    const { threads, transcripts } = make({
      maxTranscriptBytes: 400,
      maxStreamedBytes: 450,
    });
    transcripts.write("s1", SEGMENTS);
    const twin = fs.readFileSync(v2File("s1"), "utf8");
    // Over the caps: not converted, not repaired.
    put(v1File("s1"), {
      version: 1,
      sessionId: "s1",
      segments: [
        ...MORE,
        { type: "text", id: "big", source: "bot", content: "x".repeat(500) },
      ],
    });
    expect(ids(await threads.readCurrent("s1"))).toEqual(["u1", "b1"]);
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(twin);
    // Unreadable (not missing): not taken for cleared.
    fs.rmSync(v1File("s1"));
    fs.mkdirSync(v1File("s1"));
    expect(ids(await threads.readCurrent("s1"))).toEqual(["u1", "b1"]);
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(twin);
  });

  it.each([
    ["a newer version", { ...aguiThread("s1"), version: 3 }],
    [
      "an unknown source kind",
      { ...aguiThread("s1"), source: { kind: "sqlite-v3" } },
    ],
  ])("never overwrites a twin with %s", async (_label, foreign) => {
    const { threads, transcripts } = make();
    put(v2File("s1"), foreign);
    const bytes = fs.readFileSync(v2File("s1"), "utf8");
    transcripts.write("s1", MORE);
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(bytes);
    // Served from v1 in memory; the file is left for the newer build.
    expect(ids(await threads.readCurrent("s1"))).toEqual(["u1", "b1", "u2"]);
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(bytes);
  });

  it("TranscriptService.remove deletes both files and the clear marker", () => {
    const { transcripts } = make();
    transcripts.write("s1", SEGMENTS);
    expect(fs.existsSync(v2File("s1"))).toBe(true);
    transcripts.remove("s1");
    expect(fs.existsSync(v1File("s1"))).toBe(false);
    expect(fs.existsSync(v2File("s1"))).toBe(false);
    expect(fs.existsSync(markerFile("s1"))).toBe(false);
  });

  it("an interrupted clear stays cleared, across a restart, until new history is saved", async () => {
    const { threads, transcripts } = make();
    transcripts.write("s1", SEGMENTS);
    // Crash after the marker and the v1 removal, before the v2 removal.
    threads.markCleared("s1");
    fs.rmSync(v1File("s1"));
    expect(await threads.readCurrent("s1")).toEqual([]);
    const restarted = make().threads;
    expect(await restarted.readCurrent("s1")).toEqual([]);
    expect(fs.existsSync(v2File("s1"))).toBe(true);

    // The v1 removal failed instead: the same bytes are still cleared.
    transcripts.write("s2", SEGMENTS);
    threads.markCleared("s2");
    expect(await make().threads.readCurrent("s2")).toEqual([]);

    // New history after the clear is served, and the marker goes.
    const later = make();
    later.transcripts.write("s1", MORE);
    expect(ids(await later.threads.readCurrent("s1"))).toEqual([
      "u1",
      "b1",
      "u2",
    ]);
    expect(fs.existsSync(markerFile("s1"))).toBe(false);
  });

  it("an interrupted clear hides an agui twin too", async () => {
    const { threads } = make();
    put(v2File("s1"), aguiThread("s1"));
    threads.markCleared("s1");
    expect(await make().threads.readCurrent("s1")).toEqual([]);
    // The relay's next save is new history.
    threads.writeAgui("s1", { messages: [], runs: [] });
    expect(readJson(v2File("s1")).source.afterClear).toBeTypeOf("string");
    expect(fs.existsSync(markerFile("s1"))).toBe(false);
    expect(make().threads.readCurrentFile("s1")?.source.kind).toBe("agui");
  });
});

describe("C-T7 write blocks (unresolved migration attempt)", () => {
  const blockedEverything = () => {
    const held = new Set<string>();
    const isWriteBlocked = (file: string) => held.has(path.resolve(file));
    return { held, isWriteBlocked };
  };

  it("hydration, save, reset and deletion leave held files alone", async () => {
    // Settled files from before the failed attempt.
    make().transcripts.write("s1", SEGMENTS);
    const v1Bytes = fs.readFileSync(v1File("s1"), "utf8");
    const v2Bytes = fs.readFileSync(v2File("s1"), "utf8");

    const { held, isWriteBlocked } = blockedEverything();
    held.add(v1File("s1"));
    held.add(v2File("s1"));
    const errors = vi.spyOn(console, "error").mockImplementation(silent);
    const { threads, transcripts } = make(
      { isWriteBlocked },
      { isWriteBlocked }
    );

    // Hydration of a stale twin repairs in memory only.
    fs.writeFileSync(v2File("s1"), "{half");
    expect(ids(await threads.readCurrent("s1"))).toEqual(["u1", "b1"]);
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe("{half");
    fs.writeFileSync(v2File("s1"), v2Bytes);

    // Save: memory only, and both reads see it.
    transcripts.write("s1", MORE);
    expect(fs.readFileSync(v1File("s1"), "utf8")).toBe(v1Bytes);
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(v2Bytes);
    expect(transcripts.read("s1")?.segments).toHaveLength(3);
    expect(ids(await threads.readCurrent("s1"))).toEqual(["u1", "b1", "u2"]);

    // Reset: memory only; cleared for this launch, and the marker (not held)
    // keeps it cleared whatever the rollback leaves.
    transcripts.remove("s1");
    expect(fs.readFileSync(v1File("s1"), "utf8")).toBe(v1Bytes);
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(v2Bytes);
    expect(transcripts.read("s1")).toBeNull();
    expect(await threads.readCurrent("s1")).toEqual([]);
    // Still cleared after a relaunch with recovery unresolved.
    expect(
      await make({ isWriteBlocked }, { isWriteBlocked }).threads.readCurrent(
        "s1"
      )
    ).toEqual([]);

    // The relay's write to a held file stays in memory too.
    threads.writeAgui("s1", {
      messages: [{ id: "m", role: "assistant", parts: [] }],
      runs: [],
    });
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(v2Bytes);
    expect(ids(await threads.readCurrent("s1"))).toEqual(["m"]);

    // Deletion of an unheld session still works.
    transcripts.write("s2", SEGMENTS);
    transcripts.remove("s2");
    expect(fs.existsSync(v1File("s2"))).toBe(false);
    expect(fs.existsSync(v2File("s2"))).toBe(false);
    errors.mockRestore();
  });

  it("holds every file when an attempt's destinations are unknown", async () => {
    make().transcripts.write("s1", SEGMENTS);
    const before = fs.readdirSync(path.join(home, "threads")).sort();
    const { threads, transcripts } = make(
      { isWriteBlocked: () => true },
      { isWriteBlocked: () => true }
    );
    vi.spyOn(console, "error").mockImplementation(silent);
    transcripts.write("s1", MORE);
    transcripts.remove("s1");
    expect(await threads.readCurrent("s1")).toEqual([]);
    expect(fs.readdirSync(path.join(home, "threads")).sort()).toEqual(before);
    expect(fs.existsSync(v1File("s1"))).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("C-T7 r2: ownership, clears, held writes", () => {
  const held = (...files: string[]) => {
    const set = new Set(files.map((file) => path.resolve(file)));
    return (file: string) => set.has(path.resolve(file));
  };
  const quiet = () => vi.spyOn(console, "error").mockImplementation(silent);

  it("#4: never takes the fast path over a newer version that says transcript-v1", async () => {
    const { threads, transcripts } = make();
    const newer = {
      version: 3,
      threadId: "s1",
      updatedAt: "2030-01-01T00:00:00.000Z",
      source: { kind: "transcript-v1", updatedAt: "x", segments: 9 },
      messages: [],
    };
    put(v2File("s1"), newer);
    const bytes = fs.readFileSync(v2File("s1"), "utf8");
    transcripts.write("s1", MORE);
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(bytes);
    expect(ids(await threads.readCurrent("s1"))).toEqual(["u1", "b1", "u2"]);
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(bytes);
  });

  it("#5: a clear marker never lets a repair replace a protected twin", async () => {
    const { threads, transcripts } = make();
    transcripts.write("s1", SEGMENTS);
    put(v2File("s1"), { ...aguiThread("s1"), version: 3 });
    const bytes = fs.readFileSync(v2File("s1"), "utf8");
    threads.markCleared("s1");
    // New history after the clear.
    transcripts.write("s1", MORE);
    expect(ids(await make().threads.readCurrent("s1"))).toEqual([
      "u1",
      "b1",
      "u2",
    ]);
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(bytes);
  });

  it("#7: a clear with no v1 fingerprint stays cleared until a save proves new history", async () => {
    const { threads, transcripts } = make();
    transcripts.write("s1", SEGMENTS);
    const original = fs.readFileSync(v1File("s1"), "utf8");
    // v1 unreadable at clear time: the marker cannot hold its fingerprint.
    fs.rmSync(v1File("s1"));
    fs.mkdirSync(v1File("s1"));
    threads.markCleared("s1");
    // A rollback restores the original bytes; the removals had failed.
    fs.rmdirSync(v1File("s1"));
    fs.writeFileSync(v1File("s1"), original);
    expect(await make().threads.readCurrent("s1")).toEqual([]);
    // A damaged marker fails closed too.
    fs.writeFileSync(markerFile("s1"), "{damaged");
    expect(await make().threads.readCurrent("s1")).toEqual([]);
    // A save after the clear is the proof.
    const later = make();
    later.transcripts.write("s1", MORE);
    expect(ids(await make().threads.readCurrent("s1"))).toEqual([
      "u1",
      "b1",
      "u2",
    ]);
  });

  it("#8: writeAgui refuses a foreign or unreadable twin and leaves it", () => {
    const { threads } = make();
    put(v2File("s1"), { ...aguiThread("s1"), source: { kind: "future" } });
    const bytes = fs.readFileSync(v2File("s1"), "utf8");
    expect(() => threads.writeAgui("s1", { messages: [], runs: [] })).toThrow(
      /foreign/
    );
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(bytes);
    fs.mkdirSync(v2File("s2"), { recursive: true });
    expect(() => threads.writeAgui("s2", { messages: [], runs: [] })).toThrow(
      /unreadable/
    );
    expect(fs.statSync(v2File("s2")).isDirectory()).toBe(true);
  });

  it("#9: a held relay write is never replaced by a legacy dual-write", async () => {
    make().transcripts.write("s1", SEGMENTS);
    const errors = quiet();
    const blocked = held(v2File("s1"));
    const { threads, transcripts } = make(
      { isWriteBlocked: blocked },
      { isWriteBlocked: blocked }
    );
    threads.writeAgui("s1", {
      messages: [{ id: "relay", role: "assistant", parts: [] }],
      runs: [],
    });
    transcripts.write("s1", MORE);
    expect(ids(await threads.readCurrent("s1"))).toEqual(["relay"]);
    errors.mockRestore();
  });

  it("#10: a memory-only v1 save is what the thread store converts", async () => {
    make().transcripts.write("s1", SEGMENTS);
    const errors = quiet();
    const blocked = held(v1File("s1"));
    const { threads, transcripts } = make(
      { isWriteBlocked: blocked },
      { isWriteBlocked: blocked }
    );
    transcripts.write("s1", MORE);
    expect(transcripts.read("s1")?.segments).toHaveLength(3);
    expect(ids(await threads.readCurrent("s1"))).toEqual(["u1", "b1", "u2"]);
    // No backward repair against the unchanged disk v1.
    expect(readJson(v2File("s1")).source.segments).toBe(3);
    expect(ids(await threads.readCurrent("s1"))).toEqual(["u1", "b1", "u2"]);
    errors.mockRestore();
  });

  it("cut-over #7: send, reset and quit while recovery is unresolved lose nothing", async () => {
    make().transcripts.write("s1", SEGMENTS);
    make().transcripts.write("s2", SEGMENTS);
    const v1Bytes = fs.readFileSync(v1File("s1"), "utf8");
    const v2Bytes = fs.readFileSync(v2File("s1"), "utf8");
    const errors = quiet();
    const blocked = held(
      v1File("s1"),
      v2File("s1"),
      v1File("s2"),
      v2File("s2")
    );
    const first = make(
      { isWriteBlocked: blocked },
      { isWriteBlocked: blocked }
    );
    // Send: the relay persists a terminal; reset: another thread is cleared.
    first.threads.writeAgui("s1", {
      messages: [{ id: "sent", role: "assistant", parts: [] }],
      runs: [],
    });
    first.transcripts.remove("s2");
    expect(fs.readFileSync(v1File("s1"), "utf8")).toBe(v1Bytes);
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(v2Bytes);
    expect(fs.existsSync(v1File("s2"))).toBe(true);

    // Quit; relaunch with recovery still unresolved: still there, still held.
    const again = make(
      { isWriteBlocked: blocked },
      { isWriteBlocked: blocked }
    );
    expect(ids(await again.threads.readCurrent("s1"))).toEqual(["sent"]);
    expect(await again.threads.readCurrent("s2")).toEqual([]);
    expect(again.transcripts.read("s2")).toBeNull();
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(v2Bytes);

    // Relaunch once it settled: replayed onto the files.
    const settled = make();
    expect(ids(await settled.threads.readCurrent("s1"))).toEqual(["sent"]);
    expect(readJson(v2File("s1")).source.kind).toBe("agui");
    expect(await settled.threads.readCurrent("s2")).toEqual([]);
    expect(settled.transcripts.read("s2")).toBeNull();
    expect(fs.existsSync(v1File("s2"))).toBe(false);
    expect(fs.existsSync(v2File("s2"))).toBe(false);
    errors.mockRestore();
  });

  it("a held write for a thread nobody opens reaches its file at the next startup's replay", async () => {
    make().transcripts.write("s9", SEGMENTS);
    const v2Bytes = fs.readFileSync(v2File("s9"), "utf8");
    const errors = quiet();
    const blocked = held(v1File("s9"), v2File("s9"));
    make(
      { isWriteBlocked: blocked },
      { isWriteBlocked: blocked }
    ).threads.writeAgui("s9", {
      messages: [{ id: "late", role: "assistant", parts: [] }],
      runs: [],
    });
    expect(fs.readFileSync(v2File("s9"), "utf8")).toBe(v2Bytes);

    // The next launch, recovery settled: startup replays before anyone reads.
    const settled = make();
    expect(settled.threads.replayHeld()).toBe(1);
    // On disk, without the thread ever being opened through the store.
    expect(readJson(v2File("s9")).source.kind).toBe("agui");
    expect(
      readJson(v2File("s9")).messages.map((m: { id: string }) => m.id)
    ).toEqual(["late"]);
    expect(settled.threads.replayHeld()).toBe(0);
    errors.mockRestore();
  });
});

describe("C-T7 r3: Codex r3 findings", () => {
  it("#2: a v1 save held in memory is what the thread store converts, one HeldFiles for both", async () => {
    make().transcripts.write("s1", SEGMENTS);
    const errors = vi.spyOn(console, "error").mockImplementation(silent);
    // v1 and the journal are held (the change can only stay in memory);
    // the twin is writable.
    const blocked = (file: string) =>
      path.resolve(file) === path.resolve(v1File("s1")) ||
      path.resolve(file).includes(`${path.sep}.pending${path.sep}`);
    const { threads, transcripts } = make(
      { isWriteBlocked: blocked },
      { isWriteBlocked: blocked }
    );
    transcripts.write("s1", MORE);
    expect(transcripts.read("s1")?.segments).toHaveLength(3);
    expect(ids(await threads.readCurrent("s1"))).toEqual(["u1", "b1", "u2"]);
    expect(readJson(v2File("s1")).source.segments).toBe(3);
    errors.mockRestore();
  });

  it.each([
    [
      "a nested source before the top-level one",
      '{"version":2,"threadId":"s1","meta":{"source":{"kind":"transcript-v1"}},"source":{"kind":"future"},"messages":[]}',
    ],
    [
      "a nested source inside the top-level one",
      '{"version":2,"threadId":"s1","updatedAt":"x","source":{"note":{"source":{"kind":"transcript-v1"}},"kind":"future"},"messages":[]}',
    ],
  ])("#3: the fast path never trusts %s", async (_label, text) => {
    const { transcripts } = make();
    put(v2File("s1"), text);
    expect(peeksAsDerivedV2(v2File("s1"))).toBe(false);
    transcripts.write("s1", MORE);
    expect(fs.readFileSync(v2File("s1"), "utf8")).toBe(text);
  });

  it("#3: the fast path recognises exactly this build's v1-derived writer", () => {
    for (const fingerprint of [undefined, "fp"]) {
      put(
        v2File("s1"),
        JSON.stringify(
          v1ToThreadFile({
            threadId: 'odd "id"',
            updatedAt: "2026-09-01T10:00:00.000Z",
            segments: SEGMENTS,
            ...(fingerprint === undefined ? {} : { fingerprint }),
          })
        )
      );
      expect(peeksAsDerivedV2(v2File("s1"))).toBe(true);
    }
  });
});

describe("C-T7 r3: oversized v1 history (cut-over r2 #8, #9)", () => {
  const big = (id: string, size: number) => ({
    type: "text",
    id,
    source: "bot",
    content: "x".repeat(size),
  });
  const limits = { maxTranscriptBytes: 400, maxStreamedBytes: 20_000 };

  it("serves an oversized v1 file with no twin, read-only", async () => {
    const { threads, transcripts } = make(limits);
    transcripts.write("s1", [...SEGMENTS, big("b2", 1_000)]);
    expect(fs.existsSync(v2File("s1"))).toBe(false);
    const read = threads.readCurrentWithNotice("s1");
    expect(ids(read.file?.messages ?? [])).toEqual(["u1", "b1"]);
    expect(read.notice).toBeUndefined();
    expect(read.file?.source).toMatchObject({
      kind: "transcript-v1",
      fingerprint: fingerprintV1(fs.readFileSync(v1File("s1"), "utf8")),
    });
    // Never persisted: no twin is written for it.
    expect(fs.existsSync(v2File("s1"))).toBe(false);
  });

  it("past the streaming bound, answers with a typed too-large notice", () => {
    const { threads, transcripts } = make(limits);
    transcripts.write("s1", [...SEGMENTS, big("b2", 30_000)]);
    const read = threads.readCurrentWithNotice("s1");
    expect(read.file).toBeNull();
    expect(read.notice).toEqual({
      kind: "too-large",
      size: fs.statSync(v1File("s1")).size,
      limit: 20_000,
    });
  });

  it("an oversized cleared thread whose v1 removal failed stays cleared across a restart", async () => {
    const { threads, transcripts } = make(limits);
    transcripts.write("s1", [...SEGMENTS, big("b2", 1_000)]);
    // The clear: the marker is written, the v1 removal fails.
    threads.markCleared("s1");
    expect(await make(limits).threads.readCurrent("s1")).toEqual([]);
    expect(make(limits).threads.readCurrentWithNotice("s1")).toEqual({
      file: null,
    });
    // A save after the clear proves new history.
    make(limits).transcripts.write("s1", [
      { type: "text", id: "n1", source: "user", content: "new" },
      big("n2", 1_000),
    ]);
    expect(ids(await make(limits).threads.readCurrent("s1"))).toEqual([
      "n1",
      "n2",
    ]);
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

  const seed = (host: { threadStore: ThreadStore }) => {
    for (const id of ["s1", "s2"])
      new TranscriptService({ threads: host.threadStore }).write(
        id,
        SEGMENTS as never[]
      );
  };

  it("wires the thread store into dual removal", async () => {
    const host = await makeHost();
    const internals = host as unknown as Record<string, unknown>;
    expect(
      (internals.transcriptService as Record<string, unknown>).threads
    ).toBe(host.threadStore);
  }, 30_000);

  it("a reset through the legacy call and through agent.reset leaves ai.hydrate empty", async () => {
    const host = await makeHost();
    // ai.hydrate answers NOT_FOUND for a session main does not know.
    (
      (host as unknown as Record<string, unknown>)
        .agentSessionManagerService as Record<string, unknown>
    ).get = () => ({ workspaceId: "w-live" });
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
    new TranscriptService({ threads: host.threadStore }).write(
      "s3",
      SEGMENTS as never[]
    );

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
