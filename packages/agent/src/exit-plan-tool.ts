/**
 * `exit_plan_mode`: the agent asks to leave plan mode from inside the
 * conversation, so "yes, do it" is not answered by a refused write. The call
 * carries the plan for approval; the answer picks per-edit, accept-all or
 * grant-everything, and declining keeps planning. The tool does nothing itself:
 * its effect is the permission it raises (`gateToolCall`, `applyPlanDecision`).
 */
import { Type } from "typebox";

interface PiToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
    isError?: boolean;
  }>;
}

export const EXIT_PLAN_TOOL_NAME = "exit_plan_mode";

export function buildExitPlanTool(
  currentMode: () => string
): PiToolDefinitionLike {
  return {
    name: EXIT_PLAN_TOOL_NAME,
    label: EXIT_PLAN_TOOL_NAME,
    description: [
      "Ask to leave plan mode and start carrying out the plan.",
      "",
      "Call this once the plan is settled and the user wants it done, including when they",
      'say "yes" or "go ahead". Do not tell them to flip a switch: this is the switch,',
      "and asking is your job rather than theirs.",
      "",
      "Pass the plan itself so they can see what they are approving. They may approve every",
      "change individually, accept them all, or decline and keep planning.",
      "",
      "Pointless outside plan mode: you can already act.",
    ].join("\n"),
    parameters: Type.Object({
      plan: Type.String({
        description:
          "The plan you are asking to carry out, in the words you would show the user. Markdown is fine.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      // Reached only once approved (a refusal blocks the call), so the mode has
      // already changed; say so, because the model's next move depends on it.
      const plan = typeof params.plan === "string" ? params.plan.trim() : "";

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Approved. The session is now in ${currentMode()} mode, so you can make changes; ` +
              `start on the plan now rather than asking again.` +
              (plan.length > 0
                ? ""
                : " (No plan text was passed; say what you are about to do first.)"),
          },
        ],
        details: {},
      };
    },
  };
}
