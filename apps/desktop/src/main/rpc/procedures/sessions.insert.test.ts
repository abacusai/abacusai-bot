/**
 * R4-T33, spec 04 §26.4 d: `db.sessions.insert` persists `model`/`mode` at
 * creation; `agent.start` without overrides runs on the row's; the agent's
 * refusal of `agent.setModel` is `CONFLICT {reason: "model-unavailable"}`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/session/workspace-store", () => ({
  workspaceStore: {
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
  },
}));

const { AgentSessionManagerService } =
  await import("../../services/session/agent-session-manager-service");
const { ModelSwitchWaiters } =
  await import("../../services/session/model-switch");
const { AgentMode } = await import("#shared/agent-types");
const { connectInProcess, fakeDeps } = await import("../testing");

const WS = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";

const closers: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) close();
});

const connect = (serviceHost: object) => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const connection = connectInProcess(fakeDeps({ serviceHost }));
  closers.push(() => {
    connection.closeClient();
    connection.closeServer();
  });
  return connection.client;
};

const withSessions = () => {
  const sessions = new AgentSessionManagerService();
  sessions.initialize([WS]);
  const start = vi.fn(async (request: object) => ({
    success: true,
    created: true,
    state: request,
  }));
  const client = connect({
    listAllAgentSessions: () => sessions.listAll(),
    listSessionTurnStates: () => [],
    createAgentSession: (
      workspaceId: string,
      routineId: null,
      owner: null,
      id: string,
      initial: object
    ) => sessions.create(workspaceId, routineId, owner, null, id, initial),
    startAgentSession: start,
    // Not a bot session: nothing to re-pin.
    applyEffectiveBotModel: async () => undefined,
  });
  return { sessions, start, client };
};

describe("sessions insert, start and model (R4-T33)", () => {
  it("insert persists model and mode; agent.start without overrides uses them", async () => {
    const { sessions, start, client } = withSessions();

    await client.db.sessions.insert({
      id: ID,
      workspaceId: WS,
      model: "openai/gpt-5",
      mode: AgentMode.PlanMode,
    });
    expect(sessions.get(ID)).toMatchObject({
      model: "openai/gpt-5",
      mode: AgentMode.PlanMode,
    });

    await client.agent.start({ workspaceId: WS, sessionId: ID });
    expect(start).toHaveBeenLastCalledWith({
      workspaceId: WS,
      sessionId: ID,
      model: "openai/gpt-5",
      mode: AgentMode.PlanMode,
    });

    // An explicit override still wins.
    await client.agent.start({
      workspaceId: WS,
      sessionId: ID,
      mode: AgentMode.Auto,
    });
    expect(start).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: AgentMode.Auto })
    );
  });

  it("insert without model and mode leaves them null (today's row)", async () => {
    const { sessions, start, client } = withSessions();
    await client.db.sessions.insert({ id: ID, workspaceId: WS });
    expect(sessions.get(ID)).toMatchObject({ model: null, mode: null });
    await client.agent.start({ workspaceId: WS, sessionId: ID });
    expect(start).toHaveBeenLastCalledWith({ workspaceId: WS, sessionId: ID });
  });

  it("agent.setModel: the agent's refusal is CONFLICT model-unavailable with its message", async () => {
    const waiters = new ModelSwitchWaiters();
    const sent: string[] = [];
    let answer: "changed" | "refused" = "refused";
    const client = connect({
      setAgentModelChecked: (request: { sessionId: string; model: string }) =>
        waiters.wait(request.sessionId, request.model, () => {
          sent.push(request.model);
          // The agent answers on its stream, after the command.
          queueMicrotask(() =>
            waiters.feed(request.sessionId, {
              type: "event",
              event:
                answer === "changed"
                  ? { type: "model_changed", model: request.model }
                  : {
                      type: "error",
                      error: {
                        message: 'Model "nope/missing" not found.',
                        code: "model_unavailable",
                      },
                    },
            } as never)
          );
          return true;
        }),
    });
    const request = { workspaceId: WS, sessionId: ID, model: "nope/missing" };

    await expect(client.agent.setModel(request)).rejects.toMatchObject({
      code: "CONFLICT",
      defined: true,
      data: { reason: "model-unavailable" },
      message: 'Model "nope/missing" not found.',
    });
    answer = "changed";
    await expect(
      client.agent.setModel({ ...request, model: "openai/gpt-5" })
    ).resolves.toBeUndefined();
    expect(sent).toEqual(["nope/missing", "openai/gpt-5"]);
    expect(waiters.pending).toBe(0);
  });

  it("no agent to tell, or no answer in time, resolves", async () => {
    vi.useFakeTimers();
    try {
      const waiters = new ModelSwitchWaiters();
      await expect(
        waiters.wait("s", "a/a", () => false)
      ).resolves.toBeUndefined();
      const silent = waiters.wait("s", "a/a", () => true, 1_000);
      vi.advanceTimersByTime(1_000);
      await expect(silent).resolves.toBeUndefined();
      expect(waiters.pending).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
