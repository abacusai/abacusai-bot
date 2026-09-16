/**
 * Handing a self-contained piece of work to an in-process sub-agent that
 * returns only its final answer. Deliberate limits: no nesting (depth is how a
 * budget gets spent in a loop); no permission gate, since the user has no
 * context for its dialogs, so the guardrails extension is the whole policy and
 * is load-bearing; and a hard turn ceiling.
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSessionEvent,
  type ExtensionAPI,
  type InlineExtension,
  type ModelRuntime,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { confinedBashTool } from "./backends.js";
import { excludedTools } from "./excluded-tools.js";
import guardrails from "./extensions/guardrails.js";
import { windowsShellPrompt } from "./posix-shell.js";
import type { AgentEvent } from "./protocol.js";
import { whenAborted } from "./subagent-abort.js";
import { forwardChildToolEvents, traceChildEvent } from "./subagent-events.js";

export interface DelegationContext {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  model?: unknown;
  /** Skill directories the parent scans, so a sub-agent knows the same procedures. */
  skillPaths: string[];
}

/**
 * Provider retries tolerated before giving up. Nobody is watching a sub-agent,
 * so pi's retries would burn the parent's call until the wall-clock stop; two
 * rides out a blip, past that the parent deserves to be told.
 */
const MAX_PROVIDER_RETRIES = 2;

/**
 * The bounds the header promises. The tool-timeouts watchdog can report an
 * overrun but cannot end a call, so a sub-agent looping on a tool would spend
 * the parent's budget. Generous: a backstop, not a ration. The wall clock
 * matches the 900s tool-timeouts already gives `delegate_task`.
 */
const MAX_TURNS = 100;
const TIMEOUT_MS = 15 * 60 * 1000;

export interface DelegationResult {
  text: string;
  turns: number;
  stoppedBy:
    | "completed"
    | "error"
    | "provider-error"
    | "turn-limit"
    | "timeout"
    | "aborted";
}

/**
 * Run one delegated task and return what the sub-agent concluded. Never throws:
 * a failure is reported to the parent as text so it can adapt.
 */
export async function runDelegatedTask(
  context: DelegationContext,
  task: string,
  emit: (event: AgentEvent) => void,
  signal?: AbortSignal
): Promise<DelegationResult> {
  const forwardTools = forwardChildToolEvents("sub", emit);
  let turns = 0;
  let lastText = "";
  let retries = 0;
  let providerError = "";
  // On an object, not a `let`: assignments happen in callbacks control-flow
  // analysis cannot see, so a local would be narrowed to its initial value.
  const outcome: { stoppedBy: DelegationResult["stoppedBy"] } = {
    stoppedBy: "completed",
  };

  // The sub-agent runs commands through the same shell as its parent.
  const shellPrompt = windowsShellPrompt();

  try {
    const resourceLoader = new DefaultResourceLoader({
      cwd: context.cwd,
      agentDir: context.agentDir,
      settingsManager: context.settingsManager,
      additionalSkillPaths: context.skillPaths,
      appendSystemPrompt: [
        [
          "You are a sub-agent handling one self-contained task for another agent.",
          "",
          "You have the full toolset, and nobody is watching to approve anything you do — so",
          "the judgement about whether an action is wanted is yours alone. Prefer reading and",
          "reasoning; change only what the task actually asks you to change.",
          "You cannot delegate further, and you cannot ask the user anything — they are not watching.",
          "",
          "Your final message is the entire answer the calling agent receives, and it will not see",
          "your intermediate steps. Make it complete and self-contained: state what you found, name",
          "the files and identifiers that matter, and say plainly if you could not determine something.",
        ].join("\n"),
        ...(shellPrompt == null ? [] : [shellPrompt]),
      ],
      // Guardrails only: the permission gate would prompt a user who is not
      // watching, and budgets and the verify loop belong to the parent.
      extensionFactories: [
        {
          name: "abacusai-bot-guardrails",
          factory: guardrails as unknown as (pi: ExtensionAPI) => void,
        },
      ] satisfies InlineExtension[],
    });

    await resourceLoader.reload();

    // The SAME confined shell as the main session; pi's built-in bash is
    // neither
    // sandboxed nor gated, so a sub-agent would walk around the sandbox.
    const confinedBash = confinedBashTool(context.cwd);

    const created = await createAgentSession({
      cwd: context.cwd,
      agentDir: context.agentDir,
      modelRuntime: context.modelRuntime,
      resourceLoader,
      settingsManager: context.settingsManager,
      // The no-nesting rule plus the user's Capabilities choices, which must
      // reach sub-agents or the shell comes back off-switch.
      excludeTools: [
        "delegate_task",
        ...excludedTools(),
        ...(confinedBash != null ? ["bash"] : []),
      ],
      customTools: (confinedBash != null ? [confinedBash] : []) as never,
      ...(context.model != null ? { model: context.model as never } : {}),
    });

    const session = created.session;

    try {
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
        const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
          traceChildEvent("sub", event);

          // The sub-agent's tool calls, so its card shows the work (subagent-
          // events.ts).
          if (forwardTools(event)) return;

          // Provider failures arrive as an assistant message with a stopReason,
          // not an error event. `message_end`, not `message_update`: a call
          // that
          // fails outright never produces an update.
          if (event.type === "message_end") {
            const message = (
              event as {
                message?: { stopReason?: unknown; errorMessage?: unknown };
              }
            ).message;

            if (
              message?.stopReason === "error" &&
              typeof message.errorMessage === "string"
            ) {
              providerError = message.errorMessage;
            }
          }

          // `turn_end` is the per-model-call event. `agent_end` fires once per
          // prompt however many tools run, so a ceiling there could never trip.
          if (event.type === "turn_end") {
            turns += 1;

            if (turns >= MAX_TURNS) {
              outcome.stoppedBy = "turn-limit";
              unsubscribe();
              resolve();

              return;
            }
          }

          if (event.type === "agent_end") {
            // A retry left alone repeats until the wall-clock stop.
            if ((event as { willRetry?: boolean }).willRetry === true) {
              retries += 1;

              if (retries > MAX_PROVIDER_RETRIES) {
                outcome.stoppedBy = "provider-error";
                unsubscribe();
                resolve();
              }

              return;
            }

            // Read at agent_end, not accumulated from deltas, so a retried turn
            // does not glue half an abandoned message to the front.
            const messages =
              (
                event as {
                  messages?: Array<{ role?: string; content?: unknown }>;
                }
              ).messages ?? [];

            for (const message of messages) {
              if (message.role !== "assistant") continue;

              const text = extractText(message.content);

              if (text.trim().length > 0) lastText = text;
            }
          }

          if (event.type === "agent_settled") {
            unsubscribe();
            resolve();
          }
        });
      });

      // NOT awaited: `finished` carries the last message out when the run ends.
      void session.prompt(task).catch((error) => {
        outcome.stoppedBy = "error";
        providerError = error instanceof Error ? error.message : String(error);
        finish();
      });

      let timeoutTimer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timeoutTimer = setTimeout(() => {
          outcome.stoppedBy = "timeout";
          resolve();
        }, TIMEOUT_MS);
      });

      // Removed in the finally: the signal outlives this call.
      const abort = whenAborted(signal, () => {
        outcome.stoppedBy = "aborted";
      });

      try {
        // Stop arrives via the abort signal and ends the run like the timeout
        // does.
        await Promise.race([finished, timeout, abort.aborted]);
      } finally {
        if (timeoutTimer != null) clearTimeout(timeoutTimer);
        abort.dispose();
      }
    } finally {
      // A capped run can be mid-tool; a stranded child looks cut short.
      forwardTools.settle();
      session.dispose();
    }
  } catch (error) {
    return {
      text: `The delegated task failed: ${error instanceof Error ? error.message : String(error)}`,
      turns,
      stoppedBy: "error",
    };
  }

  if (outcome.stoppedBy === "error") {
    return {
      text: `The delegated task failed: ${providerError.length > 0 ? providerError : "the sub-agent prompt failed"}`,
      turns,
      stoppedBy: "error",
    };
  }

  if (outcome.stoppedBy === "provider-error") {
    const detail =
      providerError.length > 0 ? ` ${providerError.slice(0, 200)}` : "";

    return {
      text: `The model provider kept failing, so the sub-agent stopped.${detail}`,
      turns,
      stoppedBy: outcome.stoppedBy,
    };
  }

  if (outcome.stoppedBy === "aborted") {
    return {
      text: "The delegated task was stopped before it finished.",
      turns,
      stoppedBy: "aborted",
    };
  }

  if (outcome.stoppedBy === "turn-limit" || outcome.stoppedBy === "timeout") {
    const why =
      outcome.stoppedBy === "turn-limit"
        ? `stopped after ${MAX_TURNS} turns`
        : `stopped after ${TIMEOUT_MS / 60_000} minutes`;
    const partial =
      lastText.trim().length > 0
        ? `\n\nIts last message was:\n${lastText}`
        : "";

    // The parent has to know the answer is partial.
    return {
      text: `The sub-agent did not finish — it was ${why}. Treat anything below as incomplete.${partial}`,
      turns,
      stoppedBy: outcome.stoppedBy,
    };
  }

  if (lastText.trim().length === 0) {
    // A hard provider failure (no credit, bad key) is not a retry, so the run
    // ends normally with nothing said; the one sentence explaining it is here.
    if (providerError.length > 0) {
      return {
        text: `The sub-agent could not run: ${providerError.slice(0, 300)}`,
        turns,
        stoppedBy: "provider-error",
      };
    }

    return {
      text: "The sub-agent finished without producing an answer.",
      turns,
      stoppedBy: outcome.stoppedBy,
    };
  }

  return { text: lastText, turns, stoppedBy: outcome.stoppedBy };
}

/** Message content is either a string or a list of blocks, depending on the provider. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const typed = block as { type?: string; text?: string };

        return typed?.type === "text" && typeof typed.text === "string"
          ? typed.text
          : "";
      })
      .join("");
  }

  return "";
}
