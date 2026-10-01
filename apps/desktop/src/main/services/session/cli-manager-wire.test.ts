/**
 * The `--wire agui` spawn path (spec 00-agent-agui §2.4, §3.5.6), against real
 * child processes standing in for the agent: the default stays `ndjson` with
 * three pipes; `agui` adds fd 3, reads `wire.hello` from stdout line 1, feeds
 * the compat lines (from fd 3, or RS-prefixed on stdout) into the unchanged
 * NDJSON pipeline, and hands every other stdout line to the AG-UI relay.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DesktopEvent } from "#shared/agent-types";

import { AgentManagerService, type NdjsonOrigin } from "./cli-manager-service";

let workspace: string | null = null;

afterEach(() => {
  if (workspace != null) fs.rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

const READY = JSON.stringify({ type: "ready", model: "m", mode: "DEFAULT" });
const HELLO = (compat: string) =>
  JSON.stringify({
    type: "CUSTOM",
    name: "wire.hello",
    value: { protocol: 1, wire: "agui", compat, incarnation: "inc-1" },
  });
const AGUI_LINE = JSON.stringify({
  type: "CUSTOM",
  name: "agent.status",
  value: { status: "idle" },
});

/** Fake agents: print what the real one would, then idle. */
const SCRIPTS = {
  ndjson: `process.stdout.write(${JSON.stringify(`${READY}\n`)}); setInterval(() => {}, 1000);`,
  fd: `const fs = require("fs");
    fs.writeSync(1, ${JSON.stringify(`${HELLO("fd")}\n`)});
    fs.writeSync(3, ${JSON.stringify(`${JSON.stringify({ type: "compat.hello", incarnation: "inc-1" })}\n${READY}\n`)});
    fs.writeSync(1, ${JSON.stringify(`${AGUI_LINE}\n`)});
    process.stdout.write(JSON.stringify({ argv: process.argv.slice(1) }) + "\\n");
    setInterval(() => {}, 1000);`,
  inline: `process.stdout.write(${JSON.stringify(`${HELLO("inline")}\n\u001e${READY}\n${AGUI_LINE}\n`)});
    setInterval(() => {}, 1000);`,
  /** Its last line has no newline, and it exits right after writing it. */
  lastLine: `process.stdout.write(${JSON.stringify(`${HELLO("inline")}\n\u001e${READY}\n${AGUI_LINE}`)}, () => setTimeout(() => process.exit(0), 300));`,
};

function manager(script: string) {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cli-wire-"));
  const ndjson: Array<{ event: DesktopEvent; origin?: NdjsonOrigin }> = [];
  const agui: Array<Record<string, unknown>> = [];
  const service = new AgentManagerService({
    resolveWorkspacePath: () => workspace,
    resolveArtifact: () => ({
      execPath: process.execPath,
      // "--": the agent flags that follow belong to the script, not to node.
      execArgs: ["-e", script, "--"],
      agentRoot: workspace ?? "",
    }),
    resolveAuthEnv: () => ({}),
    resolveAdditionalConfigEnv: async () => ({}),
    emitStateUpdated: () => {},
    emitNdjson: (_w, _s, event, origin) => {
      ndjson.push({ event, ...(origin != null ? { origin } : {}) });
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

const runtimeOf = (service: AgentManagerService) =>
  (
    service as unknown as {
      runtimes: Map<string, { process: { stdio: unknown[] } }>;
    }
  ).runtimes.get("session-1")!;

describe("spawning with a wire", () => {
  it("always spawns AG-UI with four pipes and separate compat", async () => {
    const { service, ndjson, agui } = manager(SCRIPTS.fd);

    try {
      await service.startSession({
        workspaceId: "w",
        sessionId: "session-1",
        startupTimeoutMs: 20_000,
      });
      await vi.waitFor(() =>
        expect(ndjson.map((entry) => entry.event.type)).toContain("ready")
      );

      expect(runtimeOf(service).process.stdio).toHaveLength(4);
      expect(service.getSessionState("w", "session-1").status).toBe("running");
      expect(ndjson[0]?.origin?.wire).toBe("agui");
      expect(agui.length).toBeGreaterThan(0);
    } finally {
      await service.dispose();
    }
  }, 30_000);

  it("agui over fd 3: hello routes compat from fd 3, the preamble is dropped, AG-UI goes to the relay", async () => {
    const { service, ndjson, agui } = manager(SCRIPTS.fd);

    try {
      await service.startSession({
        workspaceId: "w",
        sessionId: "session-1",
        startupTimeoutMs: 20_000,
      });
      await vi.waitFor(() => {
        expect(ndjson.map((entry) => entry.event.type)).toEqual(["ready"]);
        expect(agui.length).toBeGreaterThanOrEqual(3);
      });

      expect(runtimeOf(service).process.stdio).toHaveLength(4);
      expect(service.getSessionState("w", "session-1").status).toBe("running");
      expect(ndjson[0]?.origin?.wire).toBe("agui");
      expect(agui[0]).toMatchObject({ name: "wire.hello" });
      expect(agui[1]).toMatchObject({ name: "agent.status" });
      const argv = (agui[2] as { argv: string[] }).argv;

      expect(argv.slice(-6)).toEqual([
        "--wire",
        "agui",
        "--thread-id",
        "session-1",
        "--compat-fd",
        "3",
      ]);
    } finally {
      await service.dispose();
    }
  }, 30_000);

  it("agui inline: RS-prefixed stdout lines are compat, the rest AG-UI", async () => {
    const { service, ndjson, agui } = manager(SCRIPTS.inline);

    try {
      await service.startSession({
        workspaceId: "w",
        sessionId: "session-1",
        startupTimeoutMs: 20_000,
      });
      await vi.waitFor(() => {
        expect(ndjson.map((entry) => entry.event)).toEqual([JSON.parse(READY)]);
        expect(agui.map((event) => event.name)).toEqual([
          "wire.hello",
          "agent.status",
        ]);
      });
      expect(service.getSessionState("w", "session-1").status).toBe("running");
    } finally {
      await service.dispose();
    }
  }, 30_000);

  it("agui: a last line without its newline still reaches the relay, before the exit", async () => {
    const { service, agui } = manager(SCRIPTS.lastLine);

    try {
      await service.startSession({
        workspaceId: "w",
        sessionId: "session-1",
        startupTimeoutMs: 20_000,
      });
      await vi.waitFor(() =>
        expect(agui.map((event) => event.name ?? event.type)).toEqual([
          "wire.hello",
          "agent.status",
          "exit",
        ])
      );
    } finally {
      await service.dispose();
    }
  }, 30_000);
});

describe("answering a runtime", () => {
  it("reaches only the runtime that asked, never a replacement", async () => {
    const { service, ndjson } = manager(SCRIPTS.fd);

    try {
      await service.startSession({
        workspaceId: "w",
        sessionId: "session-1",
        startupTimeoutMs: 20_000,
      });
      await vi.waitFor(() => expect(ndjson.length).toBeGreaterThan(0));

      const origin = ndjson[0]!.origin!;
      const command = {
        type: "permission_response",
        permissionId: "perm-1",
        decision: "accept",
      };

      expect(
        service.sendCommandToRuntime(origin, "w", "session-1", command)
      ).toBe(true);
      expect(
        service.sendCommandToRuntime(
          { wire: "agui", runtime: {} },
          "w",
          "session-1",
          command
        )
      ).toBe(false);
    } finally {
      await service.dispose();
    }
  }, 30_000);
});
