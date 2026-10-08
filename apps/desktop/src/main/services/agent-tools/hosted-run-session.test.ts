/**
 * ServiceHost.runUnattended: a hosted run gets a fresh session held to the
 * unattended mode and its declared reach, its final message comes back, and
 * the session is stopped, at its deadline too.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentStatus } from "@abacus-ai/contract/agent-types";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { HostedRunRequest } from "./hosted-run";

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

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-run-session-"));
  vi.stubEnv("ABACUSAI_BOT_HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const REQUEST: HostedRunRequest = {
  runKey: "rk",
  name: "Flight price",
  prompt: "Is it under 5000?",
  notify: "relevant",
  payload: null,
  deadlineSecs: 60,
  sources: ["https://shop.example/"],
  reads: ["calendar.read"],
  watchUrl: "https://shop.example/f/1",
  timezone: "UTC",
};

const harness = async () => {
  const { ServiceHost } = await import("../../service-host");
  const host = new ServiceHost();
  const internals = host as unknown as Record<string, any>;
  vi.spyOn(internals, "emitEvent").mockImplementation(() => {});
  vi.spyOn(host, "ensureRoutineWorkspace").mockResolvedValue("w");
  vi.spyOn(internals, "updateAgentSessionLabel").mockImplementation(() => {});
  const stop = vi
    .spyOn(internals.agentManagerService, "stopSessionAndWait")
    .mockResolvedValue(undefined as never);
  const start = vi
    .spyOn(host, "startAgentSession")
    .mockResolvedValue({ success: true } as never);
  const emit = (sessionId: string, event: Record<string, unknown>): void => {
    for (const listener of internals.agentEventListeners as Set<
      (id: string, payload: unknown) => void
    >)
      listener(sessionId, { type: "event", event });
  };
  return { host, internals, stop, start, emit };
};

it("runs held to the routine's reach and returns its final message", async () => {
  const { host, internals, stop, start, emit } = await harness();
  const sent: string[] = [];
  vi.spyOn(host, "sendAgentMessage").mockImplementation(((request: {
    sessionId: string;
    message: string;
  }) => {
    sent.push(request.message);
    queueMicrotask(() => {
      emit(request.sessionId, {
        type: "status_changed",
        status: AgentStatus.Streaming,
      });
      emit(request.sessionId, {
        type: "text_delta",
        content: "Looking…",
        messageId: "m1",
      });
      emit(request.sessionId, {
        type: "text_delta",
        content: '{"deliver": true, ',
        messageId: "m2",
      });
      emit(request.sessionId, {
        type: "text_delta",
        content: '"text": "4,800"}',
        messageId: "m2",
      });
      emit(request.sessionId, {
        type: "status_changed",
        status: AgentStatus.Idle,
      });
    });
  }) as never);

  const result = await host.runUnattended(REQUEST);

  expect(result).toEqual({
    outcome: "completed",
    text: '{"deliver": true, "text": "4,800"}',
  });
  const sessionId = start.mock.calls[0]![0].sessionId;
  expect(
    internals.agentSessionManagerService.unattendedPolicy(sessionId)
  ).toEqual({
    sources: ["https://shop.example/"],
    watchUrl: "https://shop.example/f/1",
    watchPrompt: "Is it under 5000?",
    connectorReads: {
      Google_Calendar_Tool: [
        "get_default_timezone",
        "get_calendars",
        "get_free_busy",
        "get_event",
        "search_event",
      ],
    },
    files: false,
  });
  expect(sent[0]).toContain("Is it under 5000?");
  expect(stop).toHaveBeenCalledWith("w", sessionId);
});

it("does not take startup's own statuses for the run's end", async () => {
  const { host, start, emit } = await harness();
  start.mockImplementation((async (request: { sessionId: string }) => {
    emit(request.sessionId, {
      type: "status_changed",
      status: AgentStatus.LoadingConversation,
    });
    emit(request.sessionId, {
      type: "status_changed",
      status: AgentStatus.Idle,
    });
    return { success: true };
  }) as never);
  vi.spyOn(host, "sendAgentMessage").mockImplementation(((request: {
    sessionId: string;
  }) => {
    queueMicrotask(() => {
      emit(request.sessionId, {
        type: "text_delta",
        content: "the answer",
        messageId: "m1",
      });
      emit(request.sessionId, {
        type: "status_changed",
        status: AgentStatus.Idle,
      });
    });
  }) as never);
  expect(await host.runUnattended(REQUEST)).toEqual({
    outcome: "completed",
    text: "the answer",
  });
});

it("tells a credits failure apart", async () => {
  const { host, emit } = await harness();
  vi.spyOn(host, "sendAgentMessage").mockImplementation(((request: {
    sessionId: string;
  }) => {
    queueMicrotask(() =>
      emit(request.sessionId, {
        type: "error",
        error: {
          message: "Out of credits",
          actions: [{ type: "upgrade-abacus" }],
        },
      })
    );
  }) as never);
  const result = await host.runUnattended(REQUEST);
  expect(result.outcome).toBe("failed");
  expect(result.creditsOut).toBe(true);
});

it("counts an error reported just after the idle as the run's end", async () => {
  const { host, emit } = await harness();
  vi.spyOn(host, "sendAgentMessage").mockImplementation(((request: {
    sessionId: string;
  }) => {
    queueMicrotask(() => {
      emit(request.sessionId, {
        type: "status_changed",
        status: AgentStatus.Streaming,
      });
      emit(request.sessionId, {
        type: "status_changed",
        status: AgentStatus.Idle,
      });
      emit(request.sessionId, {
        type: "error",
        error: { message: "Out", actions: [{ type: "upgrade-abacus" }] },
      });
    });
  }) as never);
  const result = await host.runUnattended(REQUEST);
  expect(result).toMatchObject({ outcome: "failed", creditsOut: true });
});

it("stops the run at its deadline", async () => {
  vi.useFakeTimers();
  try {
    const { host, stop } = await harness();
    vi.spyOn(host, "sendAgentMessage").mockImplementation((() => {}) as never);
    const running = host.runUnattended({ ...REQUEST, deadlineSecs: 5 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await running).outcome).toBe("timeout");
    expect(stop).toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("never makes a local routine on a hosted bot whose routines run on the server", async () => {
  const { ServiceHost } = await import("../../service-host");
  const host = new ServiceHost("web-host");
  const internals = host as unknown as Record<string, any>;
  vi.spyOn(internals, "emitEvent").mockImplementation(() => {});
  vi.spyOn(host.hostedRoutines, "capableNow").mockReturnValue(true);
  vi.spyOn(host.hostedRoutines, "capability").mockResolvedValue(true);
  const create = vi
    .spyOn(host.hostedRoutines, "create")
    .mockResolvedValue({ id: "hosted-r1" } as never);
  await host.createRoutine({
    runner: "local",
    prompt: "x",
    schedule: "0 9 * * *",
    botId: "bot-1",
  });
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "task", ownerBotId: "bot-1" })
  );
  // The user's own form names no author: the server refuses "user" from a bot key.
  expect(create.mock.calls[0]![0]).not.toHaveProperty("createdBy");
  // The model's reminder is the model's: it waits for the owner's approval.
  await host.createRoutine(
    {
      runner: "hosted",
      prompt: "Call Alex",
      reminderText: "Call Alex",
      runAt: 1,
    },
    undefined,
    { byAgent: true }
  );
  expect(create).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: "reminder", createdBy: "agent" })
  );
});

it("holds what the agent asks a local routine to read until the user allows it", async () => {
  const { ServiceHost } = await import("../../service-host");
  const host = new ServiceHost();
  const internals = host as unknown as Record<string, any>;
  vi.spyOn(internals, "emitEvent").mockImplementation(() => {});
  const agent = await host.createRoutine(
    {
      prompt: "x",
      schedule: "0 9 * * *",
      sources: ["https://news.example/"],
      reads: ["gmail.search"],
    },
    undefined,
    { byAgent: true }
  );
  expect(agent).toMatchObject({
    pendingReach: {
      sources: ["https://news.example/"],
      reads: ["gmail.search"],
    },
  });
  expect(agent.reach ?? null).toBeNull();
  const user = await host.createRoutine({
    prompt: "y",
    schedule: "0 9 * * *",
    sources: ["https://news.example/"],
  });
  expect(user.reach).toEqual({ sources: ["https://news.example/"], reads: [] });
  await expect(
    host.createRoutine(
      {
        prompt: "z",
        schedule: "0 9 * * *",
        sources: ["https://webhook.site/x"],
      },
      undefined,
      { byAgent: true }
    )
  ).rejects.toThrow(/cannot be a routine's sources/);
  const confirmed = await host.updateRoutine(agent.id, {
    confirmPendingReach: true,
  });
  expect(confirmed).toMatchObject({
    reach: { sources: ["https://news.example/"], reads: ["gmail.search"] },
    pendingReach: null,
  });
});

it("runs a local routine unattended, held to what the user confirmed, unless given full access", async () => {
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ apiKeys: { ABACUS_API_KEY: "k" } })
  );
  const { ServiceHost } = await import("../../service-host");
  const host = new ServiceHost();
  const internals = host as unknown as Record<string, any>;
  vi.spyOn(internals, "emitEvent").mockImplementation(() => {});
  vi.spyOn(host, "ensureRoutineWorkspace").mockResolvedValue("w");
  vi.spyOn(internals, "updateAgentSessionLabel").mockImplementation(() => {});
  vi.spyOn(host, "sendAgentMessage").mockImplementation((() => {}) as never);
  const start = vi
    .spyOn(host, "startAgentSession")
    .mockResolvedValue({ success: true } as never);
  const routine = await host.createRoutine({
    prompt: "Digest",
    schedule: "0 9 * * *",
    sources: ["https://news.example/"],
  });
  expect(await host.runRoutine(routine.id, "manual")).toBe("started");
  const held = start.mock.calls[0]![0].sessionId;
  expect(internals.agentSessionManagerService.unattendedPolicy(held)).toEqual({
    sources: ["https://news.example/"],
    watchUrl: null,
  });
  // Full access is the user's call; such a run is not held.
  await host.updateRoutine(routine.id, { access: "full" });
  await internals.agentSessionManagerService.setRunOutcome(held, "completed");
  expect(await host.runRoutine(routine.id, "manual")).toBe("started");
  const free = start.mock.calls[1]![0].sessionId;
  expect(
    internals.agentSessionManagerService.unattendedPolicy(free)
  ).toBeNull();
});

it("holds a bot's chat with anyone but its owner: no pages, reads or files", async () => {
  const { ServiceHost } = await import("../../service-host");
  const host = new ServiceHost();
  const internals = host as unknown as Record<string, any>;
  vi.spyOn(internals, "emitEvent").mockImplementation(() => {});
  const workspaceId = (await host.ensureRoutineWorkspace("sender-test"))!;
  const sender = host.createAgentSession(workspaceId, null, {
    kind: "bot",
    botId: "bot-1",
    role: "sender",
    key: "bot-1|abacus_telegram:group:-100123",
    platform: "abacus_telegram",
    senderName: "Sam",
  });
  const own = host.createAgentSession(workspaceId, null, {
    kind: "bot",
    botId: "bot-1",
    role: "forever",
    key: "bot-1",
  });
  expect(internals.heldPolicy(sender.id)).toMatchObject({
    sources: [],
    watchUrl: null,
    files: false,
  });
  expect(internals.isUnattendedSession(sender.id)).toBe(true);
  expect(internals.heldPolicy(own.id)).toBeNull();
});
