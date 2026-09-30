/**
 * The compat and AG-UI taps through the real manager and real child
 * processes (spec 07 review r1 #11): a UTF-8 character split across two
 * pipe writes arrives whole on stdout and on fd 3, long lines split over many
 * writes arrive intact, and a last line without its newline is delivered on
 * both pipes and on either wire before the exit.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopEvent } from "#shared/agent-types";

import { AgentManagerService, type AgentWire } from "./cli-manager-service";
import { LineSplitter } from "./line-splitter";

let workspace: string | null = null;

afterEach(() => {
  if (workspace != null) fs.rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

const READY = JSON.stringify({ type: "ready", model: "m", mode: "DEFAULT" });
const HELLO = JSON.stringify({
  type: "CUSTOM",
  name: "wire.hello",
  value: { protocol: 1, wire: "agui", compat: "fd", incarnation: "inc-1" },
});
const LONG = "x".repeat(300_000) + "é🙂";

/**
 * The agent stand-in: every line is cut inside a multi-byte character and
 * written in two `writeSync`s with a pause between, so the pipe delivers
 * separate chunks.
 */
const FRAGMENTED = [
  `const fs = require("fs");`,
  `const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));`,
  `const split = async (fd, text) => {`,
  `  const bytes = Buffer.from(text, "utf8");`,
  `  const at = Math.max(1, bytes.indexOf(Buffer.from("🙂", "utf8")) + 2);`,
  `  fs.writeSync(fd, bytes.subarray(0, at));`,
  `  await pause(60);`,
  `  fs.writeSync(fd, bytes.subarray(at));`,
  `  await pause(60);`,
  `};`,
  `(async () => {`,
  `  fs.writeSync(1, ${JSON.stringify(`${HELLO}\n`)});`,
  `  fs.writeSync(3, ${JSON.stringify(`${JSON.stringify({ type: "compat.hello" })}\n${READY}\n`)});`,
  `  await split(3, ${JSON.stringify(`${JSON.stringify({ type: "probe", text: "héllo 🙂 ✓" })}\n`)});`,
  `  await split(1, ${JSON.stringify(`${JSON.stringify({ type: "CUSTOM", name: "probe", value: { text: "ünï 🙂" } })}\n`)});`,
  `  const long = Buffer.from(${JSON.stringify(`${JSON.stringify({ type: "probe", text: LONG })}\n`)}, "utf8");`,
  `  for (let at = 0; at < long.length; at += 4093) {`,
  `    fs.writeSync(3, long.subarray(at, Math.min(long.length, at + 4093)));`,
  `  }`,
  `  await pause(60);`,
  // Last lines without their newline, then exit.
  `  await split(3, ${JSON.stringify(JSON.stringify({ type: "probe", text: "last compat 🙂" }))});`,
  `  await split(1, ${JSON.stringify(JSON.stringify({ type: "CUSTOM", name: "probe", value: { text: "last agui 🙂" } }))});`,
  `  setTimeout(() => process.exit(0), 150);`,
  `})();`,
].join("\n");

const NDJSON_LAST = [
  `const fs = require("fs");`,
  `fs.writeSync(1, ${JSON.stringify(`${READY}\n`)});`,
  `const bytes = Buffer.from(${JSON.stringify(JSON.stringify({ type: "probe", text: "bye 🙂" }))}, "utf8");`,
  `const at = bytes.indexOf(Buffer.from("🙂", "utf8")) + 1;`,
  `fs.writeSync(1, bytes.subarray(0, at));`,
  `setTimeout(() => { fs.writeSync(1, bytes.subarray(at)); setTimeout(() => process.exit(0), 150); }, 60);`,
].join("\n");

function manager(script: string, wire: AgentWire) {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cli-taps-"));
  const ndjson: DesktopEvent[] = [];
  const agui: Array<Record<string, unknown>> = [];
  const service = new AgentManagerService({
    resolveWorkspacePath: () => workspace,
    resolveArtifact: () => ({
      execPath: process.execPath,
      execArgs: ["-e", script, "--"],
      agentRoot: workspace ?? "",
    }),
    resolveAuthEnv: () => ({}),
    resolveAdditionalConfigEnv: async () => ({}),
    resolveWire: () => wire,
    emitStateUpdated: () => {},
    emitNdjson: (_w, _s, event) => {
      ndjson.push(event);
    },
    emitAgui: (_w, _s, event) => {
      agui.push(event);
    },
    emitAguiExit: () => {
      agui.push({ type: "exit" });
    },
    emitSystemReady: () => {},
    emitSessionClosed: () => {},
    emitMcpRuntimeServers: () => {},
    emitMcpRuntimeStatus: () => {},
    emitMcpRuntimeLog: () => {},
    emitMcpRuntimeError: () => {},
    runHostService: async () => null,
  });
  return { service, ndjson, agui };
}

const probes = (events: ReadonlyArray<Record<string, unknown>>): string[] =>
  events
    .filter(
      (event) =>
        event.type === "probe" ||
        (event.type === "CUSTOM" && event.name === "probe")
    )
    .map((event) =>
      String(
        event.type === "probe"
          ? event.text
          : (event.value as { text: string }).text
      )
    );

describe("the taps through the manager", () => {
  it("agui over fd 3: split characters, long lines and unterminated last lines arrive intact, before the exit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { service, ndjson, agui } = manager(FRAGMENTED, "agui");
    try {
      await service.startSession({
        workspaceId: "w",
        sessionId: "session-1",
        startupTimeoutMs: 20_000,
      });
      await vi.waitFor(() => expect(agui.at(-1)).toEqual({ type: "exit" }), {
        timeout: 15_000,
      });
      expect(
        probes(ndjson as unknown as Array<Record<string, unknown>>)
      ).toEqual(["héllo 🙂 ✓", LONG, "last compat 🙂"]);
      expect(probes(agui)).toEqual(["ünï 🙂", "last agui 🙂"]);
      // No replacement character anywhere.
      expect(JSON.stringify([ndjson, agui])).not.toContain("�");
    } finally {
      await service.dispose();
    }
  }, 30_000);

  it("ndjson: a split character and a last line without its newline arrive", async () => {
    const { service, ndjson } = manager(NDJSON_LAST, "ndjson");
    try {
      await service.startSession({
        workspaceId: "w",
        sessionId: "session-1",
        startupTimeoutMs: 20_000,
      });
      await vi.waitFor(
        () =>
          expect(
            probes(ndjson as unknown as Array<Record<string, unknown>>)
          ).toEqual(["bye 🙂"]),
        { timeout: 15_000 }
      );
    } finally {
      await service.dispose();
    }
  }, 30_000);
});

describe("LineSplitter", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it("joins a character split at every byte boundary, and CRLF across chunks", () => {
    const line = "añ🙂✓";
    const all = bytes(`${line}\r\n`);
    for (let cut = 1; cut < all.length; cut += 1) {
      const splitter = new LineSplitter({ maxLineChars: 100 });
      expect([
        ...splitter.push(all.subarray(0, cut)),
        ...splitter.push(all.subarray(cut)),
        ...splitter.end(),
      ]).toEqual([line]);
    }
  });

  it("keeps well-formed input byte-identical whatever the chunking", () => {
    const lines = ['{"a":"é"}', "", '{"b":"🙂"}', "plain"];
    const all = bytes(`${lines.join("\n")}\n`);
    for (const size of [1, 2, 3, 7, all.length]) {
      const splitter = new LineSplitter({ maxLineChars: 100 });
      const out: string[] = [];
      for (let at = 0; at < all.length; at += size)
        out.push(...splitter.push(all.subarray(at, at + size)));
      out.push(...splitter.end());
      expect(out).toEqual(lines);
    }
  });

  it("drops an oversize line whole (once reported), then resumes at the next line", () => {
    const overflows: number[] = [];
    const splitter = new LineSplitter({
      maxLineChars: 8,
      onOverflow: (chars) => overflows.push(chars),
    });
    expect(splitter.push("ok\n0123456")).toEqual(["ok"]);
    expect(splitter.push("789abc")).toEqual([]);
    expect(splitter.push("def")).toEqual([]);
    expect(splitter.push("ghi\nnext\n")).toEqual(["next"]);
    expect(overflows).toEqual([13]);
    // An oversize last line is not delivered at the end either.
    expect(splitter.push("0123456789")).toEqual([]);
    expect(splitter.end()).toEqual([]);
    expect(splitter.push("late\n")).toEqual([]);
  });

  it("delivers a last line without its newline at the end, and an incomplete character as a replacement", () => {
    const splitter = new LineSplitter({ maxLineChars: 100 });
    expect(splitter.push(bytes("one\ntwo"))).toEqual(["one"]);
    const cut = bytes("🙂").subarray(0, 2);
    expect(splitter.push(cut)).toEqual([]);
    expect(splitter.end()).toEqual(["two�"]);
  });
});
