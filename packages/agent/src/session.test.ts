/**
 * The rule that keeps the agent's shell reachable.
 *
 * pi applies `excludeTools` to custom tools as well as built-ins, so a name that
 * appears in both the custom tool list and the exclude list is registered and
 * then dropped. The sandboxed bash is registered under the name `bash` on
 * purpose — that is how it displaces pi's built-in — so naming `bash` in the
 * exclude list as well removes the replacement along with the thing it was
 * replacing, and the agent has no shell at all.
 *
 * That shipped, and it was invisible from the outside: the sandbox is on by
 * default on macOS, so every session there answered a shell call with "Tool bash
 * not found" as though the tool had never existed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { AgentStatus, type AgentEvent } from "./protocol.js";
import { replacesBash } from "./roster.js";
import {
  AbacusBotSession,
  capRetriesWhileRouting,
  reserveContextHeadroom,
  classifyProviderFailure,
  endedOnMalformedToolCall,
  endedOnProviderError,
  isProviderFailure,
  providerDetail,
  terminalProviderMessage,
  isSupersededWebTool,
} from "./session.js";

describe("replacing bash with our own", () => {
  it("replaces it whether or not a backend is active", () => {
    // Once the tool carries `background`, registering it only when the sandbox
    // happens to be on would make that argument exist or not depending on a
    // setting nobody connects to it.
    expect(replacesBash([])).toBe(true);
  });

  it("does not re-add bash the user switched off", () => {
    // Registering the replacement here would put the tool back as a custom one
    // and defeat the Capabilities toggle.
    expect(replacesBash(["bash"])).toBe(false);
  });

  it("is unaffected by other tools being switched off", () => {
    expect(replacesBash(["web_search", "memory"])).toBe(true);
  });

  it("never asks the caller to exclude the name it registers", () => {
    // The regression. The decision to register a replacement is returned on its
    // own, with no exclude list to mutate — so there is no longer a place where
    // "drop the built-in" can be spelled as "exclude `bash`", which pi reads as
    // "drop every tool called bash, including the one just registered".
    const excluded = ["web_search"];

    expect(replacesBash(excluded)).toBe(true);
    expect(excluded).not.toContain("bash");
  });
});

describe("which X search the model gets", () => {
  /**
   * Both halves of the decision have to be set for these to mean anything: with
   * no model key `searchAvailable()` is false and every case collapses to "not
   * superseded" for the wrong reason.
   */
  const withKeys = (xai: boolean, run: () => void): void => {
    const previousXai = process.env.ABACUSAI_BOT_DESKTOP_X_SEARCH;
    const previousModel = process.env.ANTHROPIC_API_KEY;

    process.env.ANTHROPIC_API_KEY = "test-key";
    if (xai) process.env.ABACUSAI_BOT_DESKTOP_X_SEARCH = "1";
    else delete process.env.ABACUSAI_BOT_DESKTOP_X_SEARCH;

    try {
      run();
    } finally {
      if (previousXai == null) delete process.env.ABACUSAI_BOT_DESKTOP_X_SEARCH;
      else process.env.ABACUSAI_BOT_DESKTOP_X_SEARCH = previousXai;
      if (previousModel == null) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousModel;
    }
  };

  it("keeps the server's X search when an xAI key exists", () => {
    // xAI's Live Search reads X itself. A web index filtered to x.com is the
    // weaker answer, so this process stands down rather than competing — even
    // though it could serve the call.
    withKeys(true, () => {
      expect(isSupersededWebTool({ name: "agent-tools_x_search" })).toBe(false);
    });
  });

  it("takes over when there is no xAI key but a model key", () => {
    // The whole point: X search must not be gated behind an xAI signup when the
    // app already holds a key that can search.
    withKeys(false, () => {
      expect(isSupersededWebTool({ name: "agent-tools_x_search" })).toBe(true);
    });
  });

  it("no longer arbitrates web search at all", () => {
    // There is one web search now, so there is nothing to choose between. A
    // name like this can only come from some other MCP server the user added
    // on purpose, and filtering it would delete a tool they asked for.
    withKeys(true, () => {
      expect(isSupersededWebTool({ name: "agent-tools_web_search" })).toBe(
        false
      );
    });
  });

  it("never filters an unqualified tool name", () => {
    // This process's own tools are unqualified. Filtering one here would remove
    // the tool that was about to serve the call.
    withKeys(false, () => {
      expect(isSupersededWebTool({ name: "x_search" })).toBe(false);
      expect(isSupersededWebTool({ name: "web_search" })).toBe(false);
    });
  });
});

/**
 * Gemini reports a tool call it could not serialize by ending the stream with
 * `finish_reason: MALFORMED_FUNCTION_CALL`. pi has no case for it, so it lands
 * on the default arm — `stopReason: "error"` — and none of pi's retryable
 * patterns match, so the turn stops there. What the user saw was the answer the
 * model had already streamed with a red terminal error nailed to the bottom of
 * it, and, over messaging, the raw provider string sent as a second message.
 */
describe("spotting a mangled tool call", () => {
  const assistant = (fields: Record<string, unknown>): unknown => ({
    role: "assistant",
    ...fields,
  });

  it("recognises the finish reason Gemini actually sends", () => {
    expect(
      endedOnMalformedToolCall([
        assistant({
          stopReason: "error",
          errorMessage: "Provider finish_reason: MALFORMED_FUNCTION_CALL",
        }),
      ])
    ).toBe(true);
  });

  it("recognises the same failure under other provider spellings", () => {
    for (const reason of [
      "malformed tool call",
      "MALFORMED_TOOL_CALL",
      "Malformed function call",
    ]) {
      expect(
        endedOnMalformedToolCall([
          assistant({ stopReason: "error", errorMessage: reason }),
        ])
      ).toBe(true);
    }
  });

  it("leaves every other provider failure alone", () => {
    // These are pi's business: it retries what it knows how to retry, and what
    // it gives up on is a real error the user needs to see.
    expect(
      endedOnMalformedToolCall([
        assistant({
          stopReason: "error",
          errorMessage: "429: rate limited upstream",
        }),
      ])
    ).toBe(false);
  });

  it("ignores a turn that ended cleanly", () => {
    expect(endedOnMalformedToolCall([assistant({ stopReason: "stop" })])).toBe(
      false
    );
  });

  it("reads past the tool results a turn ends with", () => {
    // The last *message* is routinely a tool result; the last thing the model
    // said is what failed.
    expect(
      endedOnMalformedToolCall([
        assistant({
          stopReason: "error",
          errorMessage: "Provider finish_reason: MALFORMED_FUNCTION_CALL",
        }),
        { role: "toolResult", content: "ok" },
      ])
    ).toBe(true);
  });

  it("does not continue past one the model already recovered from", () => {
    // A mangled call mid-turn that the model retried itself is not a failed
    // turn, and continuing would re-run work that already happened.
    expect(
      endedOnMalformedToolCall([
        assistant({
          stopReason: "error",
          errorMessage: "Provider finish_reason: MALFORMED_FUNCTION_CALL",
        }),
        assistant({ stopReason: "stop" }),
      ])
    ).toBe(false);
  });

  it("says no when the model never spoke", () => {
    expect(endedOnMalformedToolCall([])).toBe(false);
  });
});

/**
 * What OpenLLM rotates on: a turn whose last word from the model was a
 * provider failure. The free tier fails as a way of life — a shared upstream
 * quota 429s, a model disappears from the catalog overnight — and every one of
 * those is answered by moving to a different free model, so the check is
 * deliberately broad. What it must never match is a failure that switching
 * models cannot fix (a mangled tool call gets a same-model retry instead) or a
 * stop the user asked for.
 */
describe("spotting the provider error a turn died on", () => {
  const assistant = (fields: Record<string, unknown>): unknown => ({
    role: "assistant",
    ...fields,
  });

  it("returns the error text of the failure the turn ended on", () => {
    expect(
      endedOnProviderError([
        assistant({
          stopReason: "error",
          errorMessage: "429: rate limited upstream",
        }),
      ])
    ).toBe("429: rate limited upstream");
  });

  it("is not limited to rate limits", () => {
    // A 5xx or a model that left the free catalog ends the turn the same way,
    // and a different model answers all of them.
    expect(
      endedOnProviderError([
        assistant({
          stopReason: "error",
          errorMessage: "502 Bad Gateway",
        }),
      ])
    ).toBe("502 Bad Gateway");
  });

  it("answers with a placeholder when the provider said nothing", () => {
    // The caller reports the text to the user; an empty string would read as
    // a blank failure.
    expect(endedOnProviderError([assistant({ stopReason: "error" })])).toBe(
      "provider error"
    );
  });

  it("leaves a mangled tool call to the same-model retry", () => {
    // The model's own output is not the provider's fault. Rotating on it would
    // spend a fallback slot on a failure that resending to the same model
    // usually fixes.
    expect(
      endedOnProviderError([
        assistant({
          stopReason: "error",
          errorMessage: "Provider finish_reason: MALFORMED_FUNCTION_CALL",
        }),
      ])
    ).toBeNull();
  });

  it("does not mistake the user's Stop for a failure", () => {
    expect(
      endedOnProviderError([
        assistant({ stopReason: "aborted", errorMessage: "Request aborted" }),
      ])
    ).toBeNull();
  });

  it("ignores a turn that ended cleanly", () => {
    expect(
      endedOnProviderError([assistant({ stopReason: "stop" })])
    ).toBeNull();
  });

  it("reads past the tool results a turn ends with", () => {
    expect(
      endedOnProviderError([
        assistant({ stopReason: "error", errorMessage: "429: rate limited" }),
        { role: "toolResult", content: "ok" },
      ])
    ).toBe("429: rate limited");
  });

  it("does not rotate on a failure the model already recovered from", () => {
    expect(
      endedOnProviderError([
        assistant({ stopReason: "error", errorMessage: "429: rate limited" }),
        assistant({ stopReason: "stop" }),
      ])
    ).toBeNull();
  });

  it("says no when the model never spoke", () => {
    expect(endedOnProviderError([])).toBeNull();
  });
});

/**
 * The two Stop races in the OpenLLM continuation machinery.
 *
 * `agent_end` withholds the turn's idle event whenever a rotation (or a
 * malformed-call retry) is pending, on the promise that the continuation will
 * either run the turn on or end it. A Stop that lands in between used to break
 * that promise both ways: the rotation could still trigger a fresh turn after
 * the user said stop, or bail without ever emitting the terminal events —
 * leaving the session busy forever.
 */
describe("Stop racing an OpenLLM rotation", () => {
  interface SessionInternals {
    interrupted: boolean;
    modelRuntime: unknown;
    session: unknown;
    pendingOpenLlmRotation: { failure: string; nextId: string } | null;
    componentSubtasks: Map<string, string>;
    continuePastRecoverableFailures(): Promise<void>;
    rotateOpenLlmModel(): Promise<void>;
  }

  const harness = (): { s: SessionInternals; events: AgentEvent[] } => {
    const events: AgentEvent[] = [];
    const session = new AbacusBotSession({
      cwd: "/tmp",
      emit: (e) => {
        if (e.type === "event") events.push(e.event);
      },
    });

    return { s: session as unknown as SessionInternals, events };
  };

  const endedIdle = (events: AgentEvent[]): boolean =>
    events.some((e) => e.type === "turn_complete") &&
    events.some(
      (e) => e.type === "status_changed" && e.status === AgentStatus.Idle
    );

  it("ends the turn when Stop cancelled a pending rotation", async () => {
    // agent_end suppressed the idle event for this rotation; if the bail here
    // emits nothing, the desktop shows the agent busy forever.
    const { s, events } = harness();

    s.interrupted = true;
    s.pendingOpenLlmRotation = { failure: "429", nextId: "gemini/flash" };

    await s.continuePastRecoverableFailures();

    expect(s.pendingOpenLlmRotation).toBeNull();
    expect(endedIdle(events)).toBe(true);
  });

  it("does not start a turn when Stop lands while setModel is in flight", async () => {
    const { s, events } = harness();
    let continuationsSent = 0;

    s.pendingOpenLlmRotation = { failure: "429", nextId: "gemini/flash" };
    s.modelRuntime = {
      getModels: () => [{ provider: "gemini", id: "flash", name: "flash" }],
    };
    s.session = {
      model: { provider: "openrouter", id: "dead-model" },
      setModel: async () => {
        // The race: the user presses Stop while the switch is awaited.
        s.interrupted = true;
      },
      sendCustomMessage: async () => {
        continuationsSent += 1;
      },
    };

    await s.rotateOpenLlmModel();

    expect(continuationsSent).toBe(0);
    expect(endedIdle(events)).toBe(true);
  });

  it("still continues the turn when nothing interrupted the rotation", async () => {
    const { s, events } = harness();
    let continuationsSent = 0;

    s.pendingOpenLlmRotation = { failure: "429", nextId: "gemini/flash" };
    s.modelRuntime = {
      getModels: () => [{ provider: "gemini", id: "flash", name: "flash" }],
    };
    s.session = {
      model: { provider: "openrouter", id: "dead-model" },
      setModel: async () => {},
      sendCustomMessage: async () => {
        continuationsSent += 1;
      },
    };

    await s.rotateOpenLlmModel();

    expect(continuationsSent).toBe(1);
    // The turn is running on; its idle event stays withheld.
    expect(events.some((e) => e.type === "turn_complete")).toBe(false);
  });

  it("closes the turn's open subtasks when no fallback model resolves", async () => {
    // Every other turn-end path runs the shared cleanup. This one used to emit
    // its terminal events inline and skip it, so the cards for whatever was
    // running spun in the Agents pane for the rest of the session.
    const { s, events } = harness();

    s.pendingOpenLlmRotation = { failure: "429", nextId: "gemini/flash" };
    // The registry has nothing to move to, so the candidate does not resolve.
    s.modelRuntime = { getModels: () => [] };
    s.session = { model: { provider: "openrouter", id: "dead-model" } };
    s.componentSubtasks.set("call-1", "deck-1");

    await s.rotateOpenLlmModel();

    expect(events).toContainEqual({
      type: "subtask_end",
      id: "deck-1",
      status: "failed",
    });
    expect(s.componentSubtasks.size).toBe(0);
    expect(endedIdle(events)).toBe(true);
  });
});

/**
 * The OpenLLM retry cap, and who it applies to.
 *
 * The cap used to be patched onto the one SettingsManager the whole session
 * shared, so delegate sub-agents — concrete models with no rotation to fall
 * back on — had their retry budget cut to 1 as well, turning their transient
 * provider blips into hard failures.
 */
describe("retry budgets while OpenLLM routes", () => {
  it("caps the parent and leaves sub-agents the full budget", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "abacusai-bot-settings-")
    );

    try {
      let active = false;
      // The session builds these two the same way: one for itself, one for its
      // sub-agents, and only the first is capped.
      const settingsManager = SettingsManager.create(dir, dir);
      const subAgentSettingsManager = SettingsManager.create(dir, dir);

      capRetriesWhileRouting(settingsManager, () => active);

      const configured = subAgentSettingsManager.getRetrySettings().maxRetries;

      // The default budget has to exceed the cap for this test to bite.
      expect(configured).toBeGreaterThan(1);

      active = true;
      expect(settingsManager.getRetrySettings().maxRetries).toBe(1);
      expect(subAgentSettingsManager.getRetrySettings().maxRetries).toBe(
        configured
      );

      // Read at call time: switching the router off restores the budget.
      active = false;
      expect(settingsManager.getRetrySettings().maxRetries).toBe(configured);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Compaction has to run before the provider refuses, and pi's flat 16k reserve
 * stops meaning that as the window grows: it is half of a 32k model and 1.6% of
 * a million-token one, where a single large tool result crosses the threshold
 * and overshoots it in the same step.
 */
describe("how much of the context window is kept free", () => {
  const holder = (
    reserveTokens: number
  ): {
    getCompactionSettings: () => {
      enabled: boolean;
      reserveTokens: number;
      keepRecentTokens: number;
    };
  } => ({
    getCompactionSettings: () => ({
      enabled: true,
      reserveTokens,
      keepRecentTokens: 20_000,
    }),
  });

  it("scales the reserve with the window rather than fixing it", () => {
    const manager = holder(16_384);

    reserveContextHeadroom(manager, () => 1_000_000);

    // A fifth of the window, so compaction runs at 80% rather than 98.4%.
    expect(manager.getCompactionSettings().reserveTokens).toBe(200_000);
  });

  it("keeps pi's reserve when it is the larger of the two", () => {
    const manager = holder(16_384);

    // A fifth of 32k is 6,553 — less headroom than pi already asks for.
    reserveContextHeadroom(manager, () => 32_000);

    expect(manager.getCompactionSettings().reserveTokens).toBe(16_384);
  });

  it("never takes headroom away from a user who configured more", () => {
    const manager = holder(400_000);

    reserveContextHeadroom(manager, () => 1_000_000);

    expect(manager.getCompactionSettings().reserveTokens).toBe(400_000);
  });

  it("caps a routine session's context via the env budget", () => {
    const manager = holder(16_384);
    process.env.ABACUSAI_BOT_CONTEXT_CAP_TOKENS = "50000";
    try {
      reserveContextHeadroom(manager, () => 1_000_000);

      // Reserve is window - cap, so compaction triggers near 50k of usage.
      expect(manager.getCompactionSettings().reserveTokens).toBe(950_000);
    } finally {
      delete process.env.ABACUSAI_BOT_CONTEXT_CAP_TOKENS;
    }
  });

  it("ignores a nonsense cap that would swallow the window", () => {
    const manager = holder(16_384);
    process.env.ABACUSAI_BOT_CONTEXT_CAP_TOKENS = "5";
    try {
      reserveContextHeadroom(manager, () => 1_000_000);

      expect(manager.getCompactionSettings().reserveTokens).toBe(200_000);
    } finally {
      delete process.env.ABACUSAI_BOT_CONTEXT_CAP_TOKENS;
    }
  });

  it("leaves the settings alone when the window is unknown", () => {
    const manager = holder(16_384);

    // Mid-rotation, or before a model is resolved: guessing a reserve from a
    // window nobody has stated is how the 128k default caused this.
    reserveContextHeadroom(manager, () => undefined);

    expect(manager.getCompactionSettings().reserveTokens).toBe(16_384);
  });

  it("reads the window at call time, since rotation changes the model", () => {
    const manager = holder(16_384);
    let window = 32_000;

    reserveContextHeadroom(manager, () => window);
    expect(manager.getCompactionSettings().reserveTokens).toBe(16_384);

    window = 200_000;
    expect(manager.getCompactionSettings().reserveTokens).toBe(40_000);
  });
});

describe("what the provider itself said", () => {
  it("is kept when the app's reading of the failure does not carry it", () => {
    // The generic branch: a 400 nobody has a pattern for. Without this the
    // only record of the turn is "the model provider had a problem".
    expect(
      providerDetail('400: {"message":"input too large: 41231 > 32768"}')
      // The status stays on the front of it: a support conversation starts
      // with which code came back.
    ).toEqual({ detail: "400: input too large: 41231 > 32768" });
  });

  it("is left out when the message already says it", () => {
    // Nothing to add: the classifier read the sentence and wrote it out.
    const raw = '400 "Request timed out."';

    expect(terminalProviderMessage(raw)).toContain("did not respond");
    expect(providerDetail("")).toEqual({});
  });
});

describe("a provider timeout in the chat", () => {
  it("is a provider failure with or without pi's colon", () => {
    expect(isProviderFailure('400 "Request timed out."')).toBe(true);
    expect(isProviderFailure('429: {"error":"rate limited"}')).toBe(true);
    expect(isProviderFailure("Something else went wrong")).toBe(false);
  });

  it("is worded for the user, with a way to a different model", () => {
    const message = terminalProviderMessage('400 "Request timed out."');

    expect(message).toBe(
      "The model provider did not respond (400). Try again in a moment, or switch to a different model."
    );
    expect(
      classifyProviderFailure('400 "Request timed out."').remedy
    ).toContain("switch");
  });
});

describe("a request the provider's tier will not take", () => {
  // Groq's free tier: an 8,000 tokens-per-minute cap on a prompt that is
  // 14,000 tokens before the user says a word. Its sentence names a per-minute
  // limit, which used to read as a rate limit and promise a retry that cannot
  // succeed.
  const groq =
    "413: Request too large for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 14144, please reduce your message size and try again.";

  it("is told apart from a rate limit by its status", () => {
    const { summary, remedy } = classifyProviderFailure(groq);

    expect(summary).toBe("This request is too large for the model's limit");
    expect(summary).not.toContain("rate-limited");
    // A different model is the way out, so the switch action stays offered.
    expect(remedy).toContain("switch");
    expect(remedy).not.toContain("Try again in a moment");
  });

  it("is told apart by the sentence when the status is generic", () => {
    expect(
      classifyProviderFailure("400: Request Entity Too Large").summary
    ).toContain("too large");
  });

  it("does not turn a real rate limit into a size complaint", () => {
    expect(
      classifyProviderFailure(
        "429: Rate limit reached for model `x` on tokens per minute (TPM)"
      ).summary
    ).toBe("The model provider is rate-limited");
  });

  it("keeps the status on the terminal message", () => {
    expect(terminalProviderMessage(groq)).toMatch(
      /^This request is too large for the model's limit \(413\)\./
    );
  });
});
