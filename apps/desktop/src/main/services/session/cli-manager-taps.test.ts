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
import { pathToFileURL } from "node:url";

import type { FakeProvider } from "@abacus-ai/test-support/fake-provider";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopEvent } from "@abacus-ai/contract/agent-types";

// These agent-only test modules are outside desktop's composite TS project.
// Load their existing scenarios at runtime, as other cross-package harnesses do.
interface GoldenScenario {
  name: string;
  mode?: string;
  steps: Array<
    | { send: unknown }
    | { until(events: DesktopEvent[]): boolean; label: string }
  >;
}
const harnessPath = path.resolve(
  "../../packages/agent/src/agui/__tests__/harness.ts"
);
const { prepare, maskVolatile, readGolden, stopProvider, GOLDEN_ROOT } =
  (await import(pathToFileURL(harnessPath).href)) as {
    prepare(
      scenario: GoldenScenario,
      root: string
    ): Promise<{
      context: { cwd: string };
      provider: FakeProvider;
      restore(): void;
    }>;
    maskVolatile(bytes: string, port: number): string;
    readGolden(name: string): string;
    stopProvider(): Promise<void>;
    GOLDEN_ROOT: string;
  };
const scenariosPath = path.resolve(
  "../../packages/agent/src/agui/__tests__/scenarios.ts"
);
const { SCENARIOS } = (await import(pathToFileURL(scenariosPath).href)) as {
  SCENARIOS: GoldenScenario[];
};
import type { ResolvedAgentArtifact } from "./artifact-resolver-service";
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
 * written in two writes with a pause between, so the pipe delivers separate
 * chunks. Retry a full Linux pipe and finish partial writes so the payload
 * cannot truncate or terminate the stand-in with EAGAIN under CI load.
 */
const FRAGMENTED = [
  `const fs = require("fs");`,
  `const compat = process.platform === "win32" ? null : new (require("net").Socket)({ fd: 3, readable: false, writable: true });`,
  `const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));`,
  `const write = async (fd, bytes) => {`,
  `  bytes = Buffer.from(bytes);`,
  `  const stream = fd === 1 ? process.stdout : compat;`,
  `  if (stream) {`,
  `    await new Promise((resolve, reject) => stream.write(bytes, (error) => error ? reject(error) : resolve()));`,
  `    return;`,
  `  }`,
  `  for (let at = 0; at < bytes.length;) {`,
  `    try { at += fs.writeSync(fd, bytes, at, bytes.length - at, null); }`,
  `    catch (error) {`,
  `      if (error.code !== "EAGAIN") throw error;`,
  `      await pause(10);`,
  `    }`,
  `  }`,
  `};`,
  `const split = async (fd, text) => {`,
  `  const bytes = Buffer.from(text, "utf8");`,
  `  const at = Math.max(1, bytes.indexOf(Buffer.from("🙂", "utf8")) + 2);`,
  `  await write(fd, bytes.subarray(0, at));`,
  `  await pause(60);`,
  `  await write(fd, bytes.subarray(at));`,
  `  await pause(60);`,
  `};`,
  `(async () => {`,
  `  await write(1, ${JSON.stringify(`${HELLO}\n`)});`,
  `  await write(3, ${JSON.stringify(`${JSON.stringify({ type: "compat.hello" })}\n${READY}\n`)});`,
  `  await split(3, ${JSON.stringify(`${JSON.stringify({ type: "probe", text: "héllo 🙂 ✓" })}\n`)});`,
  `  await split(1, ${JSON.stringify(`${JSON.stringify({ type: "CUSTOM", name: "probe", value: { text: "ünï 🙂" } })}\n`)});`,
  `  const long = Buffer.from(${JSON.stringify(`${JSON.stringify({ type: "probe", text: LONG })}\n`)}, "utf8");`,
  `  for (let at = 0; at < long.length; at += 4093) {`,
  `    await write(3, long.subarray(at, Math.min(long.length, at + 4093)));`,
  `  }`,
  `  await pause(60);`,
  // Last lines without their newline, then exit.
  `  await split(3, ${JSON.stringify(JSON.stringify({ type: "probe", text: "last compat 🙂" }))});`,
  `  await split(1, ${JSON.stringify(JSON.stringify({ type: "CUSTOM", name: "probe", value: { text: "last agui 🙂" } }))});`,
  `  setTimeout(() => process.exit(0), 150);`,
  `})();`,
].join("\n");

afterAll(stopProvider);

function manager(
  script: string,
  artifact?: ResolvedAgentArtifact,
  cwd?: string
) {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cli-taps-"));
  // The fragmented-wire fixture exceeds Linux's single-argument limit for node -e.
  const standIn = path.join(workspace, "stand-in.cjs");
  fs.writeFileSync(standIn, script);
  const ndjson: DesktopEvent[] = [];
  const agui: Array<Record<string, unknown>> = [];
  /** Everything either wire delivered, in delivery order. */
  const log: string[] = [];
  const service = new AgentManagerService({
    resolveWorkspacePath: () => cwd ?? workspace,
    resolveArtifact: () =>
      artifact ?? {
        execPath: process.execPath,
        execArgs: [standIn, "--"],
        agentRoot: workspace ?? "",
      },
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
      try {
        await vi.waitFor(() => expect(agui.at(-1)).toEqual({ type: "exit" }), {
          timeout: 15_000,
        });
      } catch (error) {
        throw new Error(
          JSON.stringify({
            runtimes: service
              .getRuntimeDiagnostics()
              .map(({ state, stderr, live }) => ({ state, stderr, live })),
            compatEvents: ndjson.length,
            aguiEvents: agui.length,
          }),
          { cause: error }
        );
      }
      expect(
        service
          .getRuntimeDiagnostics()
          .map((record) => record.stderr)
          .join(""),
        "the fragmented writer exits without errors"
      ).toBe("");
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

for (const name of ["plain-text", "tool-bash", "permission-accept"]) {
  for (const mode of ["fd", "inline"] as const) {
    it(`R7-T7 ${name} real spawned agent preserves frozen bytes over ${mode}`, async () => {
      const scenario = SCENARIOS.find((scenario) => scenario.name === name)!;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "manager-golden-"));
      const { context, provider, restore } = await prepare(scenario, root);
      const entry = path.resolve("../../packages/agent/dist/main.js");
      const { service, ndjson } = manager(
        "",
        {
          execPath: process.execPath,
          execArgs:
            mode === "fd"
              ? [entry]
              : [
                  "-e",
                  "require('node:fs').closeSync(3);import(require('node:url').pathToFileURL(process.argv[1]).href);",
                  "--",
                  entry,
                ],
          agentRoot: path.dirname(entry),
        },
        context.cwd
      );
      try {
        const result = await service.startSession({
          workspaceId: "w",
          sessionId: "t-1",
          mode: scenario.mode as never,
          startupTimeoutMs: 20000,
        });
        expect(result.success).toBe(true);
        // The manager issues one extra mcp_list_servers command after ready.
        // Wait for its answer, assert it, then exclude only that command response
        // when comparing the agent's spontaneous stream to its frozen baseline.
        await vi.waitFor(
          () =>
            expect(
              ndjson.filter((event) => event.type === "mcp_servers")
            ).toHaveLength(2),
          { timeout: 20000 }
        );
        expect(ndjson.filter((event) => event.type === "mcp_servers")).toEqual([
          { type: "mcp_servers", servers: [] },
          { type: "mcp_servers", servers: [] },
        ]);
        for (const step of scenario.steps) {
          if ("send" in step)
            expect(service.sendCommand("w", "t-1", step.send)).toBe(true);
          else if ("until" in step)
            await vi.waitFor(
              () => expect(step.until(ndjson), step.label).toBe(true),
              { timeout: 20000 }
            );
          else throw new Error(`Unexpected golden step for ${name}`);
        }
        let snapshots = 0;
        const bytes = ndjson
          .filter((event) => event.type !== "mcp_servers" || ++snapshots === 1)
          .map((event) => JSON.stringify(event) + "\n")
          .join("");
        expect(
          maskVolatile(bytes.split(root).join(GOLDEN_ROOT), provider.port)
        ).toBe(readGolden(`${name}.ndjson`));
      } finally {
        await service.dispose();
        restore();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }, 30000);
  }
}
