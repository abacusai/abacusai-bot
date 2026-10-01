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

import { AgentManagerService } from "./cli-manager-service";
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

function manager(script: string) {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cli-taps-"));
  const ndjson: DesktopEvent[] = [];
  const agui: Array<Record<string, unknown>> = [];
  /** Everything either wire delivered, in delivery order. */
  const log: string[] = [];
  const service = new AgentManagerService({
    resolveWorkspacePath: () => workspace,
    resolveArtifact: () => ({
      execPath: process.execPath,
      execArgs: ["-e", script, "--"],
      agentRoot: workspace ?? "",
    }),
    resolveAuthEnv: () => ({}),
    resolveAdditionalConfigEnv: async () => ({}),
    emitStateUpdated: () => {},
    emitNdjson: (_w, _s, event) => {
      ndjson.push(event);
      const [text] = probes([event as unknown as Record<string, unknown>]);
      if (text != null) log.push(`compat:${text}`);
    },
    emitAgui: (_w, _s, event) => {
      agui.push(event);
      const [text] = probes([event]);
      if (text != null) log.push(`agui:${text}`);
    },
    emitAguiExit: () => {
      agui.push({ type: "exit" });
      log.push("exit");
    },
    emitSystemReady: () => {},
    emitSessionClosed: () => {},
    emitMcpRuntimeServers: () => {},
    emitMcpRuntimeStatus: () => {},
    emitMcpRuntimeLog: () => {},
    emitMcpRuntimeError: () => {},
    runHostService: async () => null,
  });
  return { service, ndjson, agui, log };
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
    const { service, ndjson, agui, log } = manager(FRAGMENTED);
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
      // One ordered log: fd 3's last (unterminated) line, and stdout's,
      // reach the taps before the exit marker, and nothing follows it.
      const exitAt = log.indexOf("exit");
      expect(exitAt).toBe(log.length - 1);
      expect(log.indexOf("compat:last compat 🙂")).toBeGreaterThan(-1);
      expect(log.indexOf("compat:last compat 🙂")).toBeLessThan(exitAt);
      expect(log.indexOf("agui:last agui 🙂")).toBeGreaterThan(-1);
      expect(log.indexOf("agui:last agui 🙂")).toBeLessThan(exitAt);
      // No replacement character anywhere.
      expect(JSON.stringify([ndjson, agui])).not.toContain("�");
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

  it("applies one limit to a line whatever the chunking, delivered or dropped alike", () => {
    const input = "ok\n0123456789\n12345678\n1234567\r\nabcdefghij";
    const expected = ["ok", "12345678", "1234567"];
    for (let size = 1; size <= input.length; size += 1) {
      const overflows: number[] = [];
      const splitter = new LineSplitter({
        maxLineChars: 8,
        onOverflow: (chars) => overflows.push(chars),
      });
      const out: string[] = [];
      for (let at = 0; at < input.length; at += size)
        out.push(...splitter.push(input.slice(at, at + size)));
      out.push(...splitter.end());
      expect({ size, out }).toEqual({ size, out: expected });
      // Each oversize line is reported exactly once.
      expect({ size, count: overflows.length }).toEqual({ size, count: 2 });
    }
  });

  it("delivers a last line without its newline at the end, and an incomplete character as a replacement", () => {
    const splitter = new LineSplitter({ maxLineChars: 100 });
    expect(splitter.push(bytes("one\ntwo"))).toEqual(["one"]);
    const cut = bytes("🙂").subarray(0, 2);
    expect(splitter.push(cut)).toEqual([]);
    expect(splitter.end()).toEqual(["two�"]);
  });
});

for (const scenario of ["plain-text", "tool-bash", "permission-accept"]) {
  for (const mode of ["fd", "inline"] as const) {
    it(`R7-T7 ${scenario} frozen bytes survive fragmented ${mode} manager input`, async () => {
      const expected = fs.readFileSync(
        path.resolve(
          "../../packages/agent/src/agui/__fixtures__",
          `${scenario}.ndjson`
        ),
        "utf8"
      );
      const hello = JSON.stringify({
        type: "CUSTOM",
        name: "wire.hello",
        value: {
          protocol: 1,
          wire: "agui",
          compat: mode,
          incarnation: "inc-1",
        },
      });
      const compat =
        mode === "fd"
          ? JSON.stringify({ type: "compat.hello" }) + "\n" + expected
          : expected;
      const bytes =
        mode === "fd"
          ? compat
          : compat
              .split("\n")
              .filter(Boolean)
              .map((line) => "\u001e" + line + "\n")
              .join("");
      const script = `const fs=require('fs');fs.writeSync(1,${JSON.stringify(hello + "\n")});const data=Buffer.from(${JSON.stringify(bytes)});let at=0;function write(){if(at===data.length){fs.writeSync(1,JSON.stringify({type:'CUSTOM',name:'session.ready',value:{}})+'\\n');setTimeout(()=>process.exit(0),40);return;}const next=Math.min(data.length,at+7);fs.writeSync(${mode === "fd" ? 3 : 1},data.subarray(at,next));at=next;setImmediate(write);}write();`;
      const { service, ndjson, agui } = manager(script);
      try {
        await service.startSession({
          workspaceId: "w",
          sessionId: "session-1",
          startupTimeoutMs: 10000,
        });
        await vi.waitFor(() => expect(agui.at(-1)).toEqual({ type: "exit" }), {
          timeout: 10000,
        });
        expect(
          ndjson.map((event) => JSON.stringify(event) + "\n").join("")
        ).toBe(expected);
      } finally {
        await service.dispose();
      }
    }, 15000);
  }
}
