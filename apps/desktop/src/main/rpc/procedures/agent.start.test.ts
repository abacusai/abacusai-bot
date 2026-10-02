import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { StartAgentSessionRequest } from "#shared/contracts";

import { AgentManagerService } from "../../services/session/cli-manager-service";
import { connectInProcess, fakeDeps } from "../testing";

vi.mock("electron", () => {
  // ServiceHost's module graph touches Electron at import; nothing of it is
  // exercised here.
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

const { ServiceHost } = await import("../../service-host");

const WS = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

const setup = (script: string, timeout = 5_000) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-start-"));
  cleanup.push(() => fs.rmSync(workspace, { recursive: true, force: true }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const config = vi.fn(async () => {
    await gate;
    return {};
  });
  const states = vi.fn();
  const manager = new AgentManagerService({
    resolveWorkspacePath: () => workspace,
    resolveArtifact: () => ({
      execPath: process.execPath,
      execArgs: ["-e", script, "--"],
      agentRoot: workspace,
    }),
    resolveAuthEnv: () => ({}),
    resolveAdditionalConfigEnv: config,
    emitStateUpdated: states,
    emitNdjson: () => {},
    emitSystemReady: () => {},
    emitSessionClosed: () => {},
    emitMcpRuntimeServers: () => {},
    emitMcpRuntimeStatus: () => {},
    emitMcpRuntimeLog: () => {},
    emitMcpRuntimeError: () => {},
    runHostService: async () => null,
  });
  cleanup.push(() => manager.dispose());
  const host = Object.assign(Object.create(ServiceHost.prototype), {
    agentManagerService: manager,
    agentSessionManagerService: { get: () => ({ model: "m" }) },
    isWorkspaceDeleted: () => false,
    getAgentSessionState: (request: {
      workspaceId: string;
      sessionId: string;
    }) => manager.getSessionState(request.workspaceId, request.sessionId),
    listAllAgentSessions: () => [],
    applyEffectiveBotModel: async () => {},
  });
  // Use the shipping ServiceHost method, with only the test deadline added.
  host.startAgentSession = (request: StartAgentSessionRequest) =>
    ServiceHost.prototype.startAgentSession.call(host, {
      ...request,
      startupTimeoutMs: timeout,
    });
  const connection = connectInProcess(fakeDeps({ serviceHost: host }));
  cleanup.push(() => {
    connection.closeClient();
    connection.closeServer();
  });
  return { client: connection.client, manager, config, states, release };
};

const READY = JSON.stringify({ type: "ready", model: "m", mode: "DEFAULT" });
const SCRIPT = `process.stdin.once('data', () => require('node:fs').writeSync(3, ${JSON.stringify(READY + "\n")})); setInterval(() => {}, 1000);`;

describe("agent.start joins readiness through the real handler", () => {
  it("joins before configuration completes and waits for ready, with one spawn", async () => {
    const { client, manager, config, states, release } = setup(SCRIPT);
    const settled = vi.fn();
    const first = client.agent
      .start({ workspaceId: WS, sessionId: ID })
      .then((result) => {
        settled();
        return result;
      });
    await vi.waitFor(() => expect(config).toHaveBeenCalledOnce());
    const second = client.agent
      .start({ workspaceId: WS, sessionId: ID })
      .then((result) => {
        settled();
        return result;
      });
    // A query on the same port proves the second request has reached main.
    await client.agent.state({ workspaceId: WS, sessionId: ID });
    expect(config).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() =>
      expect(manager.getSessionState(WS, ID).status).toBe("starting")
    );
    expect(settled).not.toHaveBeenCalled();
    manager.sendCommand(WS, ID, { type: "test-ready" });
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({
      success: true,
      created: true,
      state: { status: "running", model: "m" },
    });
    await expect(
      client.agent.start({ workspaceId: WS, sessionId: ID })
    ).resolves.toMatchObject({
      success: true,
      created: false,
      state: { status: "running", pid: results[0].state.pid },
    });
    expect(config).toHaveBeenCalledOnce();
    expect(
      states.mock.calls.filter((call) => call[2].status === "starting")
    ).toHaveLength(1);
  });

  it.each(["exit", "timeout"])(
    "shares a startup %s failure",
    async (failure) => {
      const { client, config, release } = setup(
        failure === "exit" ? "process.exit(3)" : "setInterval(() => {}, 1000)",
        failure === "timeout" ? 100 : 5_000
      );
      const first = client.agent.start({ workspaceId: WS, sessionId: ID });
      await vi.waitFor(() => expect(config).toHaveBeenCalledOnce());
      const second = client.agent.start({ workspaceId: WS, sessionId: ID });
      await client.agent.state({ workspaceId: WS, sessionId: ID });
      release();
      const results = await Promise.all([first, second]);
      expect(results[0]).toEqual(results[1]);
      expect(results[0]).toMatchObject({
        success: false,
        state: { status: "error" },
      });
      expect(results[0].error).toMatch(
        failure === "exit" ? /exited before/ : /did not emit ready/
      );
      expect(config).toHaveBeenCalledOnce();
    }
  );
});
