/**
 * The rule these pin: a session that has run keeps its own model, and the
 * workspace/global picks only fill in for one that has not.
 *
 * The bug they exist for was silent — reopening an old chat quietly moved it
 * onto whatever the last-used chat was set to, and nothing on screen said so.
 */
import { describe, expect, it } from "vitest";

import {
  modelPickHonoured,
  modelUnavailableErrorOf,
  resolveModelForSession,
  sessionModelFor,
} from "./model-selection";

describe("resolveModelForSession", () => {
  it("keeps the session's own model over the workspace pick", () => {
    expect(
      resolveModelForSession({
        sessionModel: "anthropic/claude-opus-4",
        workspaceModel: "deepseek/deepseek-v4-flash",
        globalModel: "openai/gpt-5",
      })
    ).toBe("anthropic/claude-opus-4");
  });

  it("falls back to the workspace pick for a session that has never run", () => {
    expect(
      resolveModelForSession({
        sessionModel: null,
        workspaceModel: "deepseek/deepseek-v4-flash",
        globalModel: "openai/gpt-5",
      })
    ).toBe("deepseek/deepseek-v4-flash");
  });

  it("falls back to the global pick when the workspace has none", () => {
    expect(
      resolveModelForSession({
        sessionModel: null,
        workspaceModel: null,
        globalModel: "openai/gpt-5",
      })
    ).toBe("openai/gpt-5");
  });

  it("resolves to nothing when there is nothing to resolve", () => {
    expect(
      resolveModelForSession({
        sessionModel: null,
        workspaceModel: null,
        globalModel: null,
      })
    ).toBe("");
  });

  it("treats an empty or blank id as absent", () => {
    expect(
      resolveModelForSession({
        sessionModel: "   ",
        workspaceModel: "",
        globalModel: "openai/gpt-5",
      })
    ).toBe("openai/gpt-5");
  });

  it("skips a session model that is no longer runnable", () => {
    expect(
      resolveModelForSession({
        sessionModel: "provider/removed-key-model",
        workspaceModel: "deepseek/deepseek-v4-flash",
        globalModel: null,
        runnableModelIds: ["deepseek/deepseek-v4-flash", "openai/gpt-5"],
      })
    ).toBe("deepseek/deepseek-v4-flash");
  });

  it("keeps every session model while the roster is still loading", () => {
    // An unloaded roster reads as "nothing runs". Filtering on it would drop
    // each session's model on every start, which is the bug in reverse.
    expect(
      resolveModelForSession({
        sessionModel: "anthropic/claude-opus-4",
        workspaceModel: "deepseek/deepseek-v4-flash",
        globalModel: null,
        runnableModelIds: [],
      })
    ).toBe("anthropic/claude-opus-4");
  });

  // The dropdown looked broken: picking a model resolved straight back to the
  // one the agent was already running, so the composer snapped to the old name
  // and nothing was ever pushed to the agent.
  it("lets a fresh pick outrank the model the session is running", () => {
    expect(
      resolveModelForSession({
        userPick: "openai/gpt-5",
        sessionModel: "deepseek/deepseek-v4-flash",
        workspaceModel: "deepseek/deepseek-v4-flash",
        globalModel: null,
      })
    ).toBe("openai/gpt-5");
  });

  it("still answers with the session model when nothing was picked", () => {
    expect(
      resolveModelForSession({
        userPick: null,
        sessionModel: "deepseek/deepseek-v4-flash",
        workspaceModel: "openai/gpt-5",
        globalModel: null,
      })
    ).toBe("deepseek/deepseek-v4-flash");
  });

  it("ignores a pick that cannot run, rather than stalling the composer on it", () => {
    expect(
      resolveModelForSession({
        userPick: "provider/no-key-model",
        sessionModel: "deepseek/deepseek-v4-flash",
        workspaceModel: null,
        globalModel: null,
        runnableModelIds: ["deepseek/deepseek-v4-flash", "openai/gpt-5"],
      })
    ).toBe("deepseek/deepseek-v4-flash");
  });

  it("treats a blank pick as no pick at all", () => {
    expect(
      resolveModelForSession({
        userPick: "  ",
        sessionModel: "deepseek/deepseek-v4-flash",
        workspaceModel: null,
        globalModel: null,
      })
    ).toBe("deepseek/deepseek-v4-flash");
  });
});

describe("releasing a dropdown pick", () => {
  it("holds the pick until the LIVE session reports it", () => {
    // The regression. Choosing a model persists it and optimistically patches
    // the sessions cache in the same handler, so the stored record agrees with
    // the pick immediately. Releasing on that evidence handed resolution back
    // to the model the agent was still running, and the composer snapped to
    // the old name — the bug the pick was added to fix, returning through the
    // rule that retires it.
    expect(
      modelPickHonoured("anthropic/claude-opus-5", "abacus/gpt-5.6-sol")
    ).toBe(false);
  });

  it("releases once the agent reports running it", () => {
    expect(
      modelPickHonoured("anthropic/claude-opus-5", "anthropic/claude-opus-5")
    ).toBe(true);
  });

  it("holds a pick on a session with no live model rather than releasing it", () => {
    // A stopped session reports nothing. Holding costs nothing — the pick and
    // the stored record agree — and releasing would let a stale live value win.
    expect(modelPickHonoured("anthropic/claude-opus-5", undefined)).toBe(false);
    expect(modelPickHonoured("anthropic/claude-opus-5", null)).toBe(false);
    expect(modelPickHonoured("anthropic/claude-opus-5", "")).toBe(false);
  });

  it("treats a blank pick as nothing to hold", () => {
    expect(modelPickHonoured("", "abacus/gpt-5.6-sol")).toBe(false);
    expect(modelPickHonoured(null, null)).toBe(false);
  });

  it("survives the whitespace a stored id can pick up", () => {
    expect(
      modelPickHonoured(" anthropic/claude-opus-5 ", "anthropic/claude-opus-5")
    ).toBe(true);
  });
});

describe("recognising a refused pick", () => {
  // The other way a pick ends. The agent answers an unrunnable set_model with
  // an error coded model_unavailable and never sends model_changed — the one
  // signal the release rule above waits for. Missing the refusal held the pick
  // forever: the composer named a model the agent was not running, silently.
  const refusal = (error: unknown): unknown => ({
    type: "event",
    event: { type: "error", error },
  });

  it("extracts the agent's message from a model_unavailable error event", () => {
    expect(
      modelUnavailableErrorOf(
        refusal({
          code: "model_unavailable",
          message: "Unknown model: madeup/model",
        })
      )
    ).toBe("Unknown model: madeup/model");
  });

  it("matches a refusal that carries no message, with nothing to quote", () => {
    expect(
      modelUnavailableErrorOf(refusal({ code: "model_unavailable" }))
    ).toBe("");
  });

  it("ignores errors with any other code", () => {
    expect(
      modelUnavailableErrorOf(refusal({ code: "turn_failed", message: "boom" }))
    ).toBeNull();
  });

  it("ignores every other message on the stream", () => {
    expect(
      modelUnavailableErrorOf({
        type: "event",
        event: { type: "model_changed", model: "anthropic/claude-opus-5" },
      })
    ).toBeNull();
    expect(
      modelUnavailableErrorOf({ type: "ready", model: "openai/gpt-5" })
    ).toBeNull();
  });

  it("shrugs off malformed payloads rather than throwing", () => {
    expect(modelUnavailableErrorOf(null)).toBeNull();
    expect(modelUnavailableErrorOf("error")).toBeNull();
    expect(modelUnavailableErrorOf({ type: "event" })).toBeNull();
    expect(modelUnavailableErrorOf({ type: "event", event: null })).toBeNull();
    expect(modelUnavailableErrorOf(refusal(null))).toBeNull();
    expect(modelUnavailableErrorOf(refusal("model_unavailable"))).toBeNull();
  });
});

describe("the snap-back, end to end", () => {
  // The two rules together, in the order the app applies them: pick a model on
  // a running session, the record updates first, the agent has not switched yet.
  const PICK = "anthropic/claude-opus-5";
  const RUNNING = "abacus/gpt-5.6-sol";
  const runnable = [PICK, RUNNING];

  it("keeps showing the pick while the agent is still on the old model", () => {
    expect(modelPickHonoured(PICK, RUNNING)).toBe(false);
    expect(
      resolveModelForSession({
        userPick: PICK,
        sessionModel: RUNNING,
        workspaceModel: null,
        globalModel: null,
        runnableModelIds: runnable,
      })
    ).toBe(PICK);
  });

  it("hands back to the session once the agent has switched", () => {
    expect(modelPickHonoured(PICK, PICK)).toBe(true);
    // Pick released, so resolution runs without it and agrees anyway.
    expect(
      resolveModelForSession({
        userPick: null,
        sessionModel: PICK,
        workspaceModel: null,
        globalModel: null,
        runnableModelIds: runnable,
      })
    ).toBe(PICK);
  });
});

describe("sessionModelFor", () => {
  it("is null on a new chat, whatever the last one was running", () => {
    // The session-state query holds its previous answer as placeholder data,
    // so opening a new chat leaves the last chat's model in hand. Session
    // model outranks the workspace pick, so without this gate every pick in
    // the new chat resolved straight back to the old chat's model — the
    // dropdown moved and the composer snapped back.
    expect(
      sessionModelFor({
        activeSessionId: null,
        liveModel: "abacus/route-llm-code",
        storedModel: "abacus/route-llm-code",
      })
    ).toBeNull();
  });

  it("lets a new chat take the workspace pick instead", () => {
    const resolved = resolveModelForSession({
      userPick: null,
      sessionModel: sessionModelFor({
        activeSessionId: null,
        liveModel: "openllm/auto",
        storedModel: null,
      }),
      workspaceModel: "abacus/muse-spark-1.2",
      globalModel: null,
    });

    expect(resolved).toBe("abacus/muse-spark-1.2");
  });

  it("still prefers the live model for a chat that exists", () => {
    expect(
      sessionModelFor({
        activeSessionId: "session-1",
        liveModel: "openllm/auto",
        storedModel: "abacus/muse-spark-1.2",
      })
    ).toBe("openllm/auto");
  });

  it("falls back to the stored record for a stopped chat", () => {
    expect(
      sessionModelFor({
        activeSessionId: "session-1",
        liveModel: undefined,
        storedModel: "abacus/muse-spark-1.2",
      })
    ).toBe("abacus/muse-spark-1.2");
  });
});
