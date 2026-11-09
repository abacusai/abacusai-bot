/**
 * The rule that keeps the agent's shell reachable.
 *
 * pi applies `excludeTools` to custom tools as well as built-ins, so a name that
 * appears in both the custom tool list and the exclude list is registered and
 * then dropped. The sandboxed bash is registered under the name `bash` on
 * purpose (that is how it displaces pi's built-in), so naming `bash` in the
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

import { TurnReply } from "./forever/turn-reply.js";
import { PendingSteers } from "./pending-steers.js";
import { AgentStatus, type AgentEvent } from "./protocol.js";
import { replacesBash } from "./roster.js";
import {
  AbacusBotSession,
  capRetriesWhileRouting,
  componentsPrompt,
  endedOnMalformedToolCall,
  endedOnProviderError,
  isSupersededWebTool,
} from "./session.js";
import {
  classifyAttempt,
  classifyProviderFailure,
  type FailureCause,
  EMPTY_REPLY_FAILURE,
  isProviderFailure,
  movesToOpenLlm,
  presentFailure,
  providerDetail,
  readableFailure,
  terminalProviderMessage,
} from "./turn-outcome.js";

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
    // own, with no exclude list to mutate, so there is no longer a place where
    // "drop the built-in" can be spelled as "exclude `bash`", which pi reads as
    // "drop every tool called bash, including the one just registered".
    const excluded = ["web_search"];

    expect(replacesBash(excluded)).toBe(true);
    expect(excluded).not.toContain("bash");
  });
});

describe("where a request to make something goes", () => {
  const tools = (...names: string[]): ReadonlySet<string> => new Set(names);

  it("keeps apps off the components and sends them to code that is served", () => {
    const text = componentsPrompt(tools("design", "ppt", "serve")) ?? "";

    expect(text).not.toMatch(/memo, app|apps and designs/);
    expect(text).toMatch(
      /is code: write it, run it with `serve` and hand over the URL/
    );
    expect(text).toMatch(
      /`design` is only for when the user asks to see screens/
    );
  });

  it("names only the tools the model can call", () => {
    expect(componentsPrompt(tools("serve"))).not.toMatch(/`design`/);
    expect(componentsPrompt(tools("design"))).not.toMatch(/Making apps/);
    expect(componentsPrompt(tools())).toBeNull();
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
    // weaker answer, so this process stands down rather than competing, even
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
 * on the default arm (`stopReason: "error"`), and none of pi's retryable
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
 * provider failure. The free tier fails as a way of life: a shared upstream
 * quota 429s, a model disappears from the catalog overnight, and every one of
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
 * the user said stop, or bail without ever emitting the terminal events,
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
 * shared, so delegate sub-agents (concrete models with no rotation to fall
 * back on) had their retry budget cut to 1 as well, turning their transient
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

describe("a provider envelope in words", () => {
  it.each([
    [
      "a nested error envelope",
      '429: {"error":{"code":429,"message":"Resource has been exhausted.","status":"RESOURCE_EXHAUSTED"}}',
      "429: Resource has been exhausted.",
    ],
    [
      "an error string",
      '400: {"error":"model not found"}',
      "400: model not found",
    ],
    [
      "bare JSON with no status",
      '{"error":{"message":"The model is not available."}}',
      "The model is not available.",
    ],
    [
      "JSON after a prefix",
      'Provider returned error: {"error":{"message":"Upstream timed out"}}',
      "Provider returned error: Upstream timed out",
    ],
    [
      "an envelope cut short",
      '{"error":{"message":"Context too long","details":[{"reason',
      "Context too long",
    ],
  ])("reads %s as its sentence", (_label, raw, sentence) => {
    expect(readableFailure(raw)).toBe(sentence);
  });

  it("keeps prose with no envelope as it was", () => {
    expect(readableFailure("Tool bash failed: exit 1")).toBe(
      "Tool bash failed: exit 1"
    );
  });

  it("never hands JSON to the detail", () => {
    expect(
      providerDetail(
        '400: {"error":{"message":"input too large: 41231 > 32768","code":400}}'
      )
    ).toEqual({ detail: "400: input too large: 41231 > 32768" });
  });
});

describe("the credit wall in the chat", () => {
  it("an expired free tier says it expired", () => {
    const failure = classifyProviderFailure(
      "429: Your free AbacusAI credits have expired, so you have no remaining credits to use the API."
    );

    expect(failure.summary).toBe("Your free credits have expired");
    // No plans page in the text: the card and the chat apps carry the
    // account's own upgrade link.
    expect(failure.remedy).toBe("Upgrade your plan to keep going.");
  });

  it("a provider's metric quota is a rate limit, not the Abacus wall", () => {
    expect(
      classifyProviderFailure(
        '429: {"error":{"message":"Quota exceeded for metric: generate_content_free_tier_requests"}}'
      ).summary
    ).toBe("The model provider is rate-limited");
  });
});

describe("the user's own key, refused or spent", () => {
  const pinned = (
    provider: string,
    raw: string,
    abacus: "credits" | "out" | null
  ) =>
    presentFailure(
      { cause: classifyAttempt(raw, provider), provider, raw },
      {
        routed: false,
        freeLaneProviders: [],
        onFreeLane: false,
        abacusFreeModels: [],
        abacus,
      }
    );
  const GEMINI_QUOTA =
    '429: {"error":{"code":429,"message":"Quota exceeded for metric: generate_content_free_tier_requests","status":"RESOURCE_EXHAUSTED"}}';

  it("an invalid OpenAI key with Abacus credits left names the key and offers to switch to Abacus", () => {
    const shown = pinned("openai", "401 Incorrect API key provided", "credits");
    expect(shown).toMatchObject({
      cause: "key_invalid",
      message: "Your OpenAI key was rejected — it's invalid or expired.",
      actions: [
        { type: "fix-key", provider: "openai" },
        { type: "switch-to-abacus" },
      ],
    });
    expect(shown.message).not.toMatch(/401|Incorrect API key/);
  });

  it("an invalid key with the Abacus credits used up offers the plan instead", () => {
    expect(
      pinned("openai", "401 Incorrect API key provided", "out").actions
    ).toEqual([
      { type: "fix-key", provider: "openai" },
      { type: "upgrade-abacus", cause: "exhausted" },
    ]);
  });

  it.each([
    ["a Studio key's metric quota", "gemini", GEMINI_QUOTA],
    [
      "a bare JSON 429 with no status up front",
      "gemini",
      GEMINI_QUOTA.replace(/^429: /, ""),
    ],
    [
      "another provider's credit limit",
      "xai",
      "429: You hit the credit limit for this key.",
    ],
  ])(
    "%s takes the same choice, and is never the Abacus wall's words",
    (_l, provider, raw) => {
      const shown = pinned(provider, raw, "credits");
      expect(shown.cause).toBe("own_key_quota");
      expect(shown.actions).toEqual([
        { type: "fix-key", provider },
        { type: "switch-to-abacus" },
      ]);
      expect(classifyProviderFailure(raw).summary).not.toBe(
        "You're out of credits"
      );
    }
  );

  it("without an Abacus account, a refused key keeps the fix and a model switch", () => {
    expect(
      pinned("openai", "401 Incorrect API key provided", null).actions
    ).toEqual([
      { type: "fix-key", provider: "openai" },
      { type: "switch-model" },
    ]);
  });

  it("reads the status out of a bare JSON body", () => {
    const raw =
      '{"error":{"code":429,"message":"Resource has been exhausted."}}';

    expect(isProviderFailure(raw)).toBe(true);
    expect(terminalProviderMessage(raw)).toBe(
      "The model provider is rate-limited (429). Try again in a moment, or switch to a different model."
    );
  });

  it("names the provider when the pool's own key spent its free allowance", () => {
    const raw = "429: Rate limit exceeded: free-models-per-day.";
    const shown = presentFailure(
      {
        cause: classifyAttempt(raw, "openrouter"),
        provider: "openrouter",
        raw,
      },
      {
        routed: true,
        freeLaneProviders: [],
        onFreeLane: false,
        abacusFreeModels: [],
        abacus: "credits",
      }
    );

    expect(shown.cause).toBe("own_key_quota");
    expect(shown.message).toBe(
      "Your OpenRouter key hit its quota. Switch to a different model, or check the key's plan."
    );
    expect(shown.actions).toEqual([
      { type: "switch-model" },
      { type: "fix-key", provider: "openrouter" },
    ]);
  });

  it("an Abacus-served turn past the free window carries the cause", () => {
    const actions =
      pinned(
        "abacus",
        "429: Your free AbacusAI credits have expired, so you have no remaining credits to use the API.",
        "out"
      ).actions ?? [];

    expect(actions[0]).toEqual({ type: "upgrade-abacus", cause: "expired" });
  });
});

describe("a picked model that cannot serve the turn", () => {
  const SONNET = { model: "abacus/claude-sonnet-5", label: "Sonnet 5" };
  const PLAN_REFUSAL =
    "403: Model 'claude-sonnet-5' is not available on the free tier. Call /v1/models for the models available to you, or upgrade your plan.";
  const GONE = '404: {"error":{"message":"model not found"}}';
  const DOWN = "503: Service Unavailable";
  const shown = (
    raw: string,
    abacus: "credits" | "out",
    provider = "abacus",
    routed = false
  ) =>
    presentFailure(
      { cause: classifyAttempt(raw, provider), provider, raw },
      {
        routed,
        freeLaneProviders: [],
        onFreeLane: false,
        abacusFreeModels: [{ model: "abacus/free-1", label: "Free 1" }],
        abacus,
        model: SONNET,
      }
    );

  it("an unavailable model with credits left offers RouteLLM - Open, naming the model", () => {
    const failure = shown(GONE, "credits");
    expect(failure.cause).toBe("model_unavailable");
    expect(failure.actions).toEqual([
      { type: "model-unavailable", cause: "retired", ...SONNET },
      { type: "switch-to-abacus" },
    ]);
    expect(failure.message).toBe(
      "Sonnet 5 isn't available anymore. Your message is kept."
    );
  });

  it("a provider still failing after the retries says so, with the same way on", () => {
    expect(shown(DOWN, "credits").actions).toEqual([
      { type: "model-unavailable", cause: "down", ...SONNET },
      { type: "switch-to-abacus" },
    ]);
  });

  it("with the credits used up, the plan is the way on, never a free model", () => {
    expect(shown(GONE, "out").actions).toEqual([
      { type: "model-unavailable", cause: "retired", ...SONNET },
      { type: "upgrade-abacus", cause: "exhausted" },
    ]);
  });

  it("a model the plan does not include leads with RouteLLM - Open while credits are left", () => {
    const failure = shown(PLAN_REFUSAL, "credits");
    expect(failure.cause).toBe("not_in_plan");
    // The card's secondary link is the upgrade; main locks the model.
    expect(failure.actions).toEqual([
      { type: "model-unavailable", cause: "plan", ...SONNET },
      { type: "switch-to-abacus" },
    ]);
    expect(failure.message).not.toMatch(/key/i);
    expect(shown(PLAN_REFUSAL, "out").actions?.[1]).toEqual({
      type: "upgrade-abacus",
      cause: "exhausted",
    });
  });

  it("leaves the user's own key and the pool to their own cards", () => {
    expect(
      shown("401 Incorrect API key provided", "credits", "openai").actions
    ).toEqual([
      { type: "fix-key", provider: "openai" },
      { type: "switch-to-abacus" },
    ]);
    // A model off Abacus says it is that provider's, with Abacus beside it.
    expect(shown(GONE, "credits", "openai").actions).toEqual([
      {
        type: "own-key-unavailable",
        provider: "openai",
        cause: "gone",
        ...SONNET,
      },
      { type: "switch-to-abacus" },
    ]);
    expect(
      shown(GONE, "credits", "abacus", true).actions?.some(
        (action) => action.type === "model-unavailable"
      )
    ).toBe(false);
  });
});

describe("a model the user picked that Abacus does not serve", () => {
  const KIMI = {
    model: "nvidia/moonshotai/kimi-k3",
    label: "Kimi K3",
    free: true,
  };
  const GEMINI_QUOTA =
    '429: {"error":{"code":429,"message":"Quota exceeded for metric: generate_content_free_tier_requests","status":"RESOURCE_EXHAUSTED"}}';
  const shown = (
    provider: string,
    raw: string,
    abacus: "credits" | "out" | null,
    cause = classifyAttempt(raw, provider),
    routed = false
  ) =>
    presentFailure(
      { cause, provider, raw },
      {
        routed,
        freeLaneProviders: [],
        onFreeLane: false,
        abacusFreeModels: [],
        abacus,
        model: { ...KIMI, model: `${provider}/m` },
      }
    );
  const own = (provider: string, cause: string) => ({
    type: "own-key-unavailable",
    provider,
    cause,
    model: `${provider}/m`,
    label: "Kimi K3",
    free: true,
  });

  it.each([
    ["nvidia", "410 status code (no body)", "gone"],
    ["groq", "failed to template request", "gone"],
    [
      "openrouter",
      "404 No endpoints found for moonshotai/kimi-k3:free.",
      "gone",
    ],
    [
      "openrouter",
      "429 Rate limit exceeded: limit_rpm/moonshotai/kimi-k3:free",
      "rate_limit",
    ],
    ["openrouter", "502 Bad Gateway", "down"],
    ["nvidia", "Unexpected response from the model", "failed"],
    ["groq", EMPTY_REPLY_FAILURE, "no_reply"],
    ["local", '404 model "llama3" not found', "gone"],
    ["local", "500 Internal Server Error", "down"],
  ])("%s: %s → the provider's card, %s", (provider, raw, cause) => {
    expect(shown(provider, raw, "credits").actions).toEqual([
      own(provider, cause),
      { type: "switch-to-abacus" },
    ]);
    // Credits used up: the card offers the plan, with no switch beside it.
    expect(shown(provider, raw, "out").actions).toEqual([own(provider, cause)]);
  });

  it.each([
    ["nvidia", "410 status code (no body)"],
    [
      "openrouter",
      "429 Rate limit exceeded: limit_rpm/moonshotai/kimi-k3:free",
    ],
    ["openrouter", "502 Bad Gateway"],
    ["groq", EMPTY_REPLY_FAILURE],
    ["nvidia", "Unexpected response from the model"],
    ["gemini", GEMINI_QUOTA],
    ["openai", "401 Incorrect API key provided"],
    ["local", "500 Internal Server Error"],
  ])(
    "%s: %s moves to RouteLLM - Open only signed in with credits",
    (provider, raw) => {
      const failure = { cause: classifyAttempt(raw, provider), provider, raw };
      const context = (abacus: "credits" | "out" | null, routed = false) => ({
        routed,
        freeLaneProviders: [],
        onFreeLane: false,
        abacusFreeModels: [],
        abacus,
        model: { ...KIMI, model: `${provider}/m` },
      });
      expect(movesToOpenLlm(failure, context("credits"))).toBe(true);
      expect(movesToOpenLlm(failure, context("out"))).toBe(false);
      expect(movesToOpenLlm(failure, context(null))).toBe(false);
      // Once per message: on the router it never moves again.
      expect(movesToOpenLlm(failure, context("credits", true))).toBe(false);
      // Signed out: today's card, whatever it was.
      expect(
        (shown(provider, raw, null).actions ?? []).some(
          (action) => action.type === "switch-to-abacus" || "model" in action
        )
      ).toBe(false);
    }
  );

  it("never moves an Abacus model, a dropped connection or a cut-off; an outgrown chat moves only where the loop finds room", () => {
    const context = {
      routed: false,
      freeLaneProviders: [],
      onFreeLane: false,
      abacusFreeModels: [],
      abacus: "credits" as const,
    };
    for (const failure of [
      { cause: "model_unavailable" as const, provider: "abacus", raw: "410" },
      { cause: "connection" as const, provider: "nvidia", raw: "fetch failed" },
      { cause: "stream_cut" as const, provider: "gemini", raw: "cut" },
    ])
      expect(movesToOpenLlm(failure, context)).toBe(false);
    // The fit ladder's move: the loop checks the target's window first.
    expect(
      movesToOpenLlm(
        { cause: "context_too_long", provider: "nvidia", raw: "413" },
        context
      )
    ).toBe(true);
  });

  it("a stall ends on the same card off Abacus, and on its own line on Abacus", () => {
    const raw = "no reply in 120s";
    const off = shown("nvidia", raw, "credits", "stalled");
    expect(off.cause).toBe("stalled");
    expect(off.actions).toEqual([
      own("nvidia", "no_reply"),
      { type: "switch-to-abacus" },
    ]);
    const on = shown("abacus", raw, "credits", "stalled");
    expect(on.message).toBe(
      "The model stopped answering (no output for 120s). Try again, or switch to a different model."
    );
    // A pinned Abacus model with credits left: the switch is RouteLLM - Open.
    expect(on.actions).toEqual([
      { type: "switch-to-abacus" },
      { type: "switch-model" },
    ]);
  });

  it("keeps the key's own card, and leaves Abacus and the pool alone", () => {
    // A refused or spent key: fix it, or Abacus.
    expect(shown("gemini", GEMINI_QUOTA, "credits").actions).toEqual([
      { type: "fix-key", provider: "gemini" },
      { type: "switch-to-abacus" },
    ]);
    // On the pool the router picked no model.
    expect(
      shown("nvidia", "410 status code (no body)", "credits", undefined, true)
        .actions
    ).toEqual([{ type: "switch-model" }]);
    // Abacus's own model: its own card, as before.
    expect(
      shown("abacus", "410 status code (no body)", "credits").actions?.[0]?.type
    ).toBe("model-unavailable");
  });
});

describe("every card's model switch, by where the Abacus credits stand", () => {
  const at = (
    failure: { cause: FailureCause; provider: string; raw: string },
    abacus: "credits" | "out" | null,
    routed = false
  ) =>
    presentFailure(failure, {
      routed,
      freeLaneProviders: [],
      onFreeLane: false,
      abacusFreeModels: [],
      abacus,
    }).actions ?? [];
  it.each([
    [
      "an outgrown chat",
      "context_too_long",
      "413 Request Entity Too Large",
      [{ type: "new-chat" }],
    ],
    ["an empty reply", "empty", EMPTY_REPLY_FAILURE, [{ type: "retry" }]],
    ["a stall", "stalled", "no reply in 120s", []],
    ["a provider error", "unknown", "400 Bad Request: something odd", []],
  ] as const)(
    "%s on Abacus: RouteLLM - Open with credits left, the plan's offer without, today's card signed out or on RouteLLM - Open",
    (_name, cause, raw, kept) => {
      const failure = { cause: cause as FailureCause, provider: "abacus", raw };
      expect(at(failure, "credits")).toEqual([
        ...kept,
        { type: "switch-to-abacus" },
        { type: "switch-model" },
      ]);
      expect(at(failure, "out")).toEqual([...kept, { type: "plan-offer" }]);
      expect(at(failure, null)).toEqual([...kept, { type: "switch-model" }]);
      expect(at(failure, "credits", true)).not.toContainEqual({
        type: "switch-to-abacus",
      });
    }
  );

  it("leaves Abacus's own refusals alone: RouteLLM - Open runs on Abacus", () => {
    const payment = at(
      {
        cause: "payment_required",
        provider: "abacus",
        raw: '402 "We could not confirm the last payment on this subscription."',
      },
      "credits"
    );
    expect(payment.map((action) => action.type)).toEqual([
      "payment-required",
      "switch-model",
    ]);
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

it("does not diagnose a provider authorization denial as an invalid key", () => {
  const failure = classifyProviderFailure('403 {"error":"Forbidden"}');
  expect(failure.summary).toBe("The model provider denied access");
  expect(failure.remedy).toContain("Settings → Models");
  expect(classifyProviderFailure("401 Unauthorized").summary).toBe(
    "The model provider rejected the key"
  );
});

it("reads a model the plan does not include as the plan, not the key", () => {
  // The platform's free-tier refusal of a paid model: the key is fine, and
  // "check the key" sent the user to a page with nothing wrong on it.
  const failure = classifyProviderFailure(
    `403 {"error":{"message":"Model 'claude-sonnet-5' is not available on the free tier. Call /v1/models for the models available to you, or upgrade your plan."}}`
  );
  expect(failure.summary).toBe("This model isn't included in your plan");
  expect(failure.remedy).toContain("Upgrade your plan");
  expect(failure.summary).not.toContain("key");
});

it("names a key of the wrong kind and sends the user back through sign-in", () => {
  // The platform's answer to a terminal/CodeLLM key on a bot endpoint. The
  // key is valid, so "check your model access" would send the user to the
  // wrong page.
  const failure = classifyProviderFailure(
    '403 {"error":"Abacus AI Agent Desktop is not allowed for this API"}'
  );
  expect(failure.summary).toBe("This key isn't an AbacusAI Bot key");
  expect(failure.remedy).toContain("Sign out");
  expect(failure.remedy).toContain("Settings → Account");
  expect(failure.remedy).not.toContain("Settings → Models");
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
    expect(remedy).toMatch(/switch/i);
    expect(remedy).not.toContain("Try again in a moment");
    // One request over the tier's limit: a new chat would not fit either.
    expect(remedy).not.toMatch(/new chat/i);
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

describe("steers on their way to the model", () => {
  it("lands the oldest of two identical texts first, each with its own id", () => {
    const steers = new PendingSteers();
    steers.add("ok", "m1");
    steers.add("ok", "m2");
    steers.add("no id");
    expect(steers.take("ok")).toEqual({ text: "ok", messageId: "m1" });
    expect(steers.take("ok")).toEqual({ text: "ok", messageId: "m2" });
    expect(steers.take("ok")).toBeNull();
    expect(steers.take("no id")).toEqual({ text: "no id" });
  });

  it("forgets everything on clear", () => {
    const steers = new PendingSteers();
    steers.add("ok", "m1");
    steers.clear();
    expect(steers.take("ok")).toBeNull();
  });
});

describe("a turn's reply", () => {
  it("names the send and its steers, and keeps the last message with words", () => {
    const reply = new TurnReply();
    reply.begin("m1");
    reply.messageStarted();
    reply.textStreamed("Let me look.");
    reply.messageEnded(true);
    expect(reply.answers("m2")).toBeNull();
    reply.messageStarted();
    reply.messageEnded(true);
    reply.messageStarted();
    reply.textStreamed("Found ");
    reply.textStreamed("it.");
    reply.messageEnded(false);
    expect(reply.take()).toEqual({
      type: "turn_reply",
      messageIds: ["m1", "m2"],
      text: "Found it.",
      failed: false,
    });
  });

  it("hands over a finished answer a steer lands behind, and only that", () => {
    const steeredBehind = (
      messages: Array<[words: string, calledTool: boolean]>
    ) => {
      const reply = new TurnReply();
      reply.begin("m1");
      for (const [words, calledTool] of messages) {
        reply.messageStarted();
        reply.textStreamed(words);
        reply.messageEnded(calledTool);
      }
      return { reply, answered: reply.answers("m2") };
    };
    const answer = {
      type: "turn_answer",
      messageIds: ["m1"],
      text: "Your calendar is empty.",
    };
    for (const [messages, expected] of [
      [[["Your calendar is empty.", false]], answer],
      [
        [
          ["", true],
          ["Your calendar is empty.", false],
        ],
        answer,
      ],
      [
        [
          ["Your calendar is empty.", false],
          ["", false],
        ],
        answer,
      ],
      [[["Let me check.", true]], null],
      [
        [
          ["Let me check.", false],
          ["", true],
        ],
        null,
      ],
      [[["", false]], null],
    ] as const)
      expect(
        steeredBehind(messages as never).answered,
        JSON.stringify(messages)
      ).toEqual(expected);

    // Said once: the reply is what came after it, for every message.
    const { reply } = steeredBehind([["Your calendar is empty.", false]]);
    expect(reply.answers("m3")).toBeNull();
    reply.messageStarted();
    reply.textStreamed("4");
    reply.messageEnded(false);
    expect(reply.take()).toMatchObject({
      messageIds: ["m1", "m2", "m3"],
      text: "4",
    });

    // A sender that never gave an id hears nothing new.
    const silent = new TurnReply();
    silent.begin();
    silent.messageStarted();
    silent.textStreamed("Hello.");
    silent.messageEnded(false);
    expect(silent.answers()).toBeNull();
  });

  it("is taken once; a steer after that belongs to no reply and runs as its own send", () => {
    const reply = new TurnReply();
    reply.begin("m1");
    reply.fail();
    expect(reply.take()).toMatchObject({ messageIds: ["m1"], failed: true });
    reply.answers("m2");
    reply.fail();
    expect(reply.take()).toBeNull();
    reply.begin("m2");
    expect(reply.take()).toEqual({
      type: "turn_reply",
      messageIds: ["m2"],
      text: "",
      failed: false,
    });
  });

  it("says nothing for a send without an id, or a stopped turn", () => {
    const reply = new TurnReply();
    reply.begin();
    expect(reply.take()).toBeNull();
    reply.begin("m1");
    reply.abandon();
    expect(reply.take()).toBeNull();
  });
});
