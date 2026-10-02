/** R7-T7: the built agent, production ServiceHost wiring, and real tap consumers. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  FakeMcpServer,
  mcpConfig,
} from "@abacus-ai/test-support/fake-mcp-server";
import {
  FakeProvider,
  fakeProviderConfig,
} from "@abacus-ai/test-support/fake-provider";
import { expect, it, vi } from "vitest";

vi.mock("electron", () => {
  const anything: unknown = new Proxy(function () {}, {
    get: (_target, key) => (key === "then" ? undefined : anything),
    apply: () => anything,
    construct: () => anything as object,
  });
  return new Proxy(
    {
      default: anything,
      app: {
        isPackaged: false,
        getPath: () => process.env.ABACUSAI_BOT_HOME,
        getVersion: () => "1.0.86",
      },
    },
    {
      get: (target, key) =>
        key in target
          ? (target as Record<PropertyKey, unknown>)[key]
          : key === "then"
            ? undefined
            : anything,
      has: () => true,
    }
  );
});
vi.mock("electron-store", () => ({
  default: class {
    private values: Record<string, unknown>;
    constructor(options: { defaults?: Record<string, unknown> } = {}) {
      this.values = { ...options.defaults };
    }
    get(key: string, fallback?: unknown) {
      return this.values[key] ?? fallback;
    }
    set(key: string, value: unknown) {
      this.values[key] = value;
    }
    delete(key: string) {
      delete this.values[key];
    }
    onDidChange() {
      return () => {};
    }
  },
}));

import { AgentMode, AgentStatus, type DesktopEvent } from "#shared/agent-types";

import { AgentManagerService } from "./cli-manager-service";
import { SessionTurnStateService } from "./session-turn-state-service";

for (const transport of ["fd", "inline"] as const) {
  it(`R7-T7 production artifact, messaging, routine, waiter, browser, host-service and watchdog effects over ${transport}`, async () => {
    const root = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "production-taps-"))
    );
    const home = path.join(root, "home"),
      cwd = path.join(root, "workspace");
    fs.mkdirSync(home);
    fs.mkdirSync(cwd);
    vi.stubEnv("ABACUSAI_BOT_HOME", home);
    const provider = await FakeProvider.start();
    const browser = await FakeMcpServer.start([
      { name: "browser_navigate", reply: () => "navigated test page" },
    ]);
    fs.writeFileSync(
      path.join(home, "config.json"),
      fakeProviderConfig(provider)
    );
    fs.writeFileSync(
      path.join(home, "mcp.json"),
      mcpConfig({ browser: { url: browser.url, isBuiltin: true } })
    );
    let manager: AgentManagerService | undefined;
    try {
      const { ServiceHost } = await import("../../service-host");
      const host = new ServiceHost();
      // Replace only boundaries: process artifact, auth/config, workspace lookup,
      // network connector and event publication. Consumers and wiring stay real.
      const internals = host as unknown as Record<string, any>;
      vi.spyOn(internals.workspaceService, "getWorkspaces").mockReturnValue([
        { id: "w", path: cwd, isRemote: false },
      ]);
      vi.spyOn(internals, "emitEvent").mockImplementation(() => {});
      const entry = path.resolve("../../packages/agent/dist/main.js");
      manager = internals.agentManagerService;
      const options = (manager as unknown as { options: Record<string, any> })
        .options;
      options.resolveArtifact = () => ({
        execPath: process.execPath,
        execArgs:
          transport === "fd"
            ? [entry]
            : [
                "-e",
                "require('node:fs').closeSync(3);import(require('node:url').pathToFileURL(process.argv[1]).href);",
                "--",
                entry,
              ],
        agentRoot: path.dirname(entry),
      });
      options.resolveAuthEnv = () => ({});
      options.resolveAdditionalConfigEnv = async () => ({
        ABACUSAI_BOT_HOME: home,
        ABACUSAI_BOT_MCP_CONFIG: path.join(home, "mcp.json"),
        PI_OFFLINE: "1",
        ABACUSAI_BOT_EXCLUDED_TOOLS: "browser_task",
      });
      const compat: DesktopEvent[] = [];
      const productionTap = options.emitNdjson;
      options.emitNdjson = (...args: any[]) => {
        compat.push(args[2]);
        productionTap(...args);
      };
      const hostService = vi.spyOn(options, "runHostService");
      const communication = vi.spyOn(
        internals.agentCommunicationService,
        "handleDesktopEvent"
      );
      const patches = vi.spyOn(manager!, "applyStatePatch");
      const watchdog =
        internals.sessionTurnStateService as SessionTurnStateService;
      const filter = vi.spyOn(watchdog, "filterDesktopEvent");
      const resets = vi.spyOn(
        watchdog as unknown as {
          resetActivityTimer(w: string, s: string): void;
        },
        "resetActivityTimer"
      );
      const { createJob } = await import("../agent-tools/cron-store");
      createJob({ prompt: "test routine" }, "tap-routine");
      internals.agentSessionManagerService.create(
        "w",
        "tap-routine",
        null,
        "manual",
        "s"
      );
      // A routine session also owns a synthetic inbound route. The connector is
      // an in-memory boundary; no message leaves the test process.
      const sent = vi.fn().mockResolvedValue(undefined);
      internals.messagingGatewayService.connectors.set("telegram", {
        sendText: sent,
      });
      const route = {
        platform: "telegram",
        chatId: "test-chat",
        sessionId: "s",
        workspaceId: "w",
        userId: "test-user",
        buffer: "",
        bufferMessageId: null,
        taggedReply: null,
        busy: true,
        busySince: Date.now(),
        queue: [],
        queueFullNotified: false,
        viaBot: false,
        senderLabel: "test",
        pendingIntro: null,
      };
      const gateway = internals.messagingGatewayService;
      gateway.routesBySession.set("s", route);
      let parentRound = 0,
        childRound = 0;
      provider.script((call) => {
        if (call.tools.includes("document_templates"))
          return childRound++ === 0
            ? { call: { name: "document_templates", args: {} } }
            : { say: "The host catalog arrived." };
        switch (parentRound++) {
          case 0:
            return {
              call: {
                name: "write",
                args: {
                  path: "artifact.txt",
                  content: "production artifact\n",
                },
              },
            };
          case 1:
            return {
              call: {
                name: "browser_navigate",
                args: { url: "https://example.invalid" },
              },
            };
          case 2:
            return {
              call: {
                name: "document",
                args: {
                  brief: "Read the document catalog",
                  output_path: "catalog.pdf",
                },
              },
            };
          default:
            return { say: "<reply>Production tap reply</reply>" };
        }
      });
      // Manual approvals for ordinary tools. Browser approval must come from
      // production AgentCommunicationService, bound to the emitting runtime.
      const permission = options.emitNdjson;
      options.emitNdjson = (...args: any[]) => {
        permission(...args);
        const event = args[2] as DesktopEvent;
        if (
          event.type === "permission_needed" &&
          event.request.tool.name !== "browser_navigate"
        )
          manager!.sendCommandToRuntime(args[3], "w", "s", {
            type: "permission_response",
            permissionId: event.permissionId,
            decision: "accept",
          });
      };
      const start = await manager!.startSession({
        workspaceId: "w",
        sessionId: "s",
        mode: AgentMode.Normal,
        startupTimeoutMs: 20000,
      });
      expect(start.success).toBe(true);
      const waiter = internals.waitForTurn("s", 30000) as Promise<string>;
      watchdog.markSent("w", "s");
      expect(
        manager!.sendCommandToSession("s", {
          type: "send",
          message: "exercise taps",
        })
      ).not.toBeNull();
      const reply = await waiter;
      expect(reply).toContain("Production tap reply");
      await vi.waitFor(() =>
        expect(sent).toHaveBeenCalledWith(
          "test-chat",
          "Production tap reply",
          undefined
        )
      );
      expect(route.busy).toBe(false);
      expect(fs.readFileSync(path.join(cwd, "artifact.txt"), "utf8")).toBe(
        "production artifact\n"
      );
      expect(internals.sessionArtifactsService.list()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: "s",
            toolName: "write",
            location: fs.realpathSync(path.join(cwd, "artifact.txt")),
          }),
        ])
      );
      expect(internals.agentSessionManagerService.get("s").runOutcome).toBe(
        "completed"
      );
      const { readLastRoutineRun, routineDir } =
        await import("../agent-tools/routine-runs-store");
      expect(readLastRoutineRun(routineDir("tap-routine"))).toMatchObject({
        sessionId: "s",
        outcome: "completed",
        reply: expect.stringContaining("Production tap reply"),
      });
      expect(
        browser.calls,
        JSON.stringify({
          tools: provider.calls[0]?.tools,
          errors: compat.filter(
            (e) =>
              e.type === "event" &&
              ["error", "tool_execution_complete"].includes(e.event.type)
          ),
        })
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "browser_navigate" }),
        ])
      );
      expect(internals.sessionArtifactsService.list()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "link",
            location: "https://example.invalid",
            toolName: "browser_navigate",
          }),
        ])
      );
      expect(communication).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "event",
          event: expect.objectContaining({
            type: "tool_execution_complete",
            tool: expect.objectContaining({ name: "browser_navigate" }),
          }),
        })
      );
      expect(patches).toHaveBeenCalledWith(
        "w",
        "s",
        expect.objectContaining({ agentStatus: AgentStatus.ExecutingTool })
      );
      expect(hostService).toHaveBeenCalledWith("document_templates", {});
      expect(
        await hostService.mock.results.find(
          (result) => result.type === "return"
        )!.value
      ).toMatchObject({ templates: expect.any(Array) });
      expect(filter).toHaveBeenCalledWith(
        "w",
        "s",
        expect.objectContaining({
          type: "event",
          event: expect.objectContaining({ type: "tool_execution_start" }),
        })
      );
      expect(resets.mock.calls.length).toBeGreaterThan(10);
      expect(watchdog.get("w", "s")).toMatchObject({
        phase: "idle",
        isBusy: false,
      });
      expect(
        (
          watchdog as unknown as { activityTimers: Map<string, unknown> }
        ).activityTimers.has("s")
      ).toBe(false);
      expect(manager!.getRuntimeInfo("s")?.wire).toBe("agui");
      expect(
        (
          manager as unknown as {
            runtimes: Map<string, { compatMode: string }>;
          }
        ).runtimes.get("s")?.compatMode
      ).toBe(transport);
    } finally {
      await manager?.dispose();
      await browser.close();
      await provider.close();
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
}
