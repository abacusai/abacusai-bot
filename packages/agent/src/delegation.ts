/**
 * Handing a self-contained piece of work to an in-process sub-agent that
 * returns only its final answer. Deliberate limits: no nesting (depth is how a
 * budget gets spent in a loop); no permission gate, since the user has no
 * context for its dialogs, so the guardrails extension is the whole policy and
 * is load-bearing; a turn budget (subagent-run.ts); and a scope, the one
 * folder the task is about (extensions/scope-guard.ts).
 */
import * as fs from "node:fs";
import * as os from "node:os";

import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type InlineExtension,
  type ModelRuntime,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { confinedBashTool } from "./backends.js";
import { excludedTools } from "./excluded-tools.js";
import guardrails from "./extensions/guardrails.js";
import { scopeGuard, taskScope } from "./extensions/scope-guard.js";
import { windowsShellPrompt } from "./posix-shell.js";
import type { AgentEvent } from "./protocol.js";
import { forwardChildToolEvents } from "./subagent-events.js";
import {
  runSubagent,
  SUBAGENT_TURNS,
  type SubagentRunResult,
  type SubagentStop,
} from "./subagent-run.js";
import {
  isInsideDirectory,
  realPathOf,
  resolveInWorkspace,
} from "./workspace-path.js";

export interface DelegationContext {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  model?: unknown;
  /** Skill directories the parent scans, so a sub-agent knows the same procedures. */
  skillPaths: string[];
}

/** Matches the 900s tool-timeouts already gives `delegate_task`. */
const TIMEOUT_MS = 15 * 60 * 1000;

export interface DelegationResult {
  text: string;
  turns: number;
  stoppedBy: SubagentStop;
}

/**
 * The folder a task is about, from the parent's `root` (absolute, `~/`, or
 * relative to its own folder; its own folder when absent). Home itself, or
 * anything above it, is not a folder a task is about.
 */
export function resolveTaskRoot(
  raw: string | undefined,
  cwd: string
): { root: string } | { error: string } {
  const root = resolveInWorkspace(raw?.trim() || ".", cwd);
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(root).isDirectory();
  } catch {
    // Missing: reported below.
  }
  if (!isDirectory)
    return { error: `root ${raw} is not a folder on this machine.` };

  const home = realPathOf(os.homedir()) ?? os.homedir();
  const real = realPathOf(root) ?? root;
  // Not for the parent's own default: a session working in home keeps it.
  if (raw != null && raw.trim() !== "" && isInsideDirectory(home, real))
    return {
      error: `root ${raw} is the home folder or above it; name the project folder the task is about.`,
    };

  return { root };
}

/**
 * Run one delegated task and return what the sub-agent concluded. Never throws:
 * a failure is reported to the parent as text so it can adapt.
 *
 * @param root  The folder the task is about, already through resolveTaskRoot;
 *              the parent's own folder when absent.
 */
export async function runDelegatedTask(
  context: DelegationContext,
  task: string,
  emit: (event: AgentEvent) => void,
  signal?: AbortSignal,
  root: string = context.cwd
): Promise<DelegationResult> {
  const forwardTools = forwardChildToolEvents("sub", emit);
  let run: SubagentRunResult;
  // Skills are read from where they are installed, outside any task's root.
  const scope = taskScope(root, task, [
    context.agentDir,
    ...context.skillPaths,
  ]);

  // The sub-agent runs commands through the same shell as its parent.
  const shellPrompt = windowsShellPrompt();

  try {
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: context.agentDir,
      settingsManager: context.settingsManager,
      additionalSkillPaths: context.skillPaths,
      appendSystemPrompt: [
        [
          "You are a sub-agent handling one self-contained task for another agent.",
          "",
          "You have the full toolset, and nobody is watching to approve anything you do, so",
          "the judgement about whether an action is wanted is yours alone. Prefer reading and",
          "reasoning; change only what the task actually asks you to change.",
          "You cannot delegate further, and you cannot ask the user anything: they are not watching.",
          "",
          "Your final message is the entire answer the calling agent receives, and it will not see",
          "your intermediate steps. Make it complete and self-contained: state what you found, name",
          "the files and identifiers that matter, and say plainly if you could not determine something.",
          "",
          `This task is about ${root}. Work there and with any path the task names. If something`,
          "you need is not there, report it as missing: do not search the rest of this machine for",
          "a copy, since another checkout or version would answer a different question. Paths",
          "elsewhere in the user's home folder are refused.",
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
        { name: "abacusai-bot-scope-guard", factory: scopeGuard(scope) },
      ] satisfies InlineExtension[],
    });

    await resourceLoader.reload();

    // The SAME confined shell as the main session; pi's built-in bash is
    // neither sandboxed nor gated, so a sub-agent would walk around the
    // sandbox. A custom tool replaces the built-in by name; it must NOT also
    // go in `excludeTools`, which pi applies to custom tools too; that left
    // a sub-agent with no shell at all wherever a backend was active.
    const confinedBash = confinedBashTool(root);

    const created = await createAgentSession({
      cwd: root,
      agentDir: context.agentDir,
      modelRuntime: context.modelRuntime,
      resourceLoader,
      settingsManager: context.settingsManager,
      // The no-nesting rule plus the user's Capabilities choices, which must
      // reach sub-agents or the shell comes back off-switch.
      excludeTools: ["delegate_task", ...excludedTools()],
      customTools: (confinedBash != null ? [confinedBash] : []) as never,
      ...(context.model != null ? { model: context.model as never } : {}),
    });

    const session = created.session;

    try {
      run = await runSubagent(session, task, {
        tag: "sub",
        forwardTools,
        timeoutMs: TIMEOUT_MS,
        ...(signal != null ? { signal } : {}),
      });
    } finally {
      // A capped run can be mid-tool; a stranded child looks cut short.
      forwardTools.settle();
      session.dispose();
    }
  } catch (error) {
    return {
      text: `The delegated task failed: ${error instanceof Error ? error.message : String(error)}`,
      turns: 0,
      stoppedBy: "error",
    };
  }

  // A hard provider failure (no credit, bad key) is not a retry, so the run
  // "completes" with nothing said; that is a provider error to the parent.
  const silentFailure =
    run.stoppedBy === "completed" &&
    run.text.trim().length === 0 &&
    run.providerError.length > 0;

  return {
    text: answerText(run) + scopeNote(scope.root, scope.refused),
    turns: run.turns,
    stoppedBy: silentFailure ? "provider-error" : run.stoppedBy,
  };
}

/** What the parent reads: the answer, or plainly why there is none. */
function answerText(run: SubagentRunResult): string {
  const { stoppedBy, text, providerError } = run;

  switch (stoppedBy) {
    case "error":
      return `The delegated task failed: ${providerError.length > 0 ? providerError : "the sub-agent prompt failed"}`;
    case "provider-error":
      return `The model provider kept failing, so the sub-agent stopped.${providerError.length > 0 ? ` ${providerError.slice(0, 200)}` : ""}`;
    case "aborted":
      return "The delegated task was stopped before it finished.";
    case "turn-limit":
    case "timeout": {
      const why =
        stoppedBy === "turn-limit"
          ? `stopped after ${SUBAGENT_TURNS.max} turns`
          : `stopped after ${TIMEOUT_MS / 60_000} minutes`;
      // The parent has to know the answer is partial.
      if (run.closedOut)
        return `The sub-agent did not finish (it was ${why}). Its closing report follows; treat it as incomplete.\n\n${text}`;
      return `The sub-agent did not finish (it was ${why}). Treat anything below as incomplete.${text.trim().length > 0 ? `\n\nIts last message was:\n${text}` : ""}`;
    }
    case "completed":
      if (text.trim().length > 0) return text;
      return providerError.length > 0
        ? `The sub-agent could not run: ${providerError.slice(0, 300)}`
        : "The sub-agent finished without producing an answer.";
  }
}

/**
 * What the parent learns when the run reached outside its folder: the
 * refusals are the one sign that something the task needed is not there.
 */
function scopeNote(root: string, refused: string[]): string {
  if (refused.length === 0) return "";
  const unique = [...new Set(refused)];
  const shown = unique.slice(0, 5).join(", ");
  const more = unique.length > 5 ? ` and ${unique.length - 5} more` : "";

  return (
    `\n\n(Scope: the sub-agent was kept inside ${root} and refused ${unique.length} ` +
    `path(s) outside it: ${shown}${more}. If it needed them, they are missing from ${root}.)`
  );
}
