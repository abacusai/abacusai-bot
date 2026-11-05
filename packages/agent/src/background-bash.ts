/**
 * `bash` with `background: true`: the same command, but the call returns once
 * it is running and the result is delivered later (extensions/background.ts),
 * so a deadline never kills a twenty-minute build. Wraps pi's own definition
 * rather than replacing it; foreground calls go straight to pi untouched.
 */
import { Type } from "typebox";

import { startBackgroundJob } from "./background-processes.js";

interface BashLikeDefinition {
  name: string;
  label: string;
  description: string;
  parameters: { properties: Record<string, unknown> };
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown
  ) => Promise<unknown>;
  [key: string]: unknown;
}

interface OperationsLike {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    }
  ) => Promise<{ exitCode: number | null }>;
}

/**
 * What pi's own description does not say: tool-timeouts stamps a budget on
 * every call without one, so "no default timeout" is false here, and a model
 * told there is no deadline has no reason to raise it.
 */
const TIMEOUT_GUIDANCE = [
  "",
  "A call with no timeout gets 120 seconds, and is killed at it. Set timeout (in seconds, up to",
  "600) for anything that legitimately takes longer. Installs and scaffolds (npm/pnpm/yarn",
  "install, npx, create-next-app, pip install, cargo build, git clone, docker build, winget,",
  "composer, apt) are given 1800 automatically; you do not need to ask for it, and you should",
  "not background them: the next step needs the files they write.",
].join("\n");

const BACKGROUND_GUIDANCE = [
  "",
  "Set background: true for work that takes longer than you are willing to sit on: a build, a",
  "test suite, a long install, a training run, or a server to leave up. The call returns as",
  "soon as the command is running and you keep working. If it finishes while you are still",
  "working you are told, with its output, without polling. Once your reply is done you do not",
  "get another turn for it: the user is told it finished, and you get its output with their",
  "next message. So do not end your reply on work that needs the result; wait for it, or say",
  "plainly that it is still running and what they should expect.",
  "",
  "A background run has no deadline unless you set timeout, and a timeout stops it: never set",
  "one on a server. Stop one early with kill_process. For a static page use serve instead.",
].join("\n");

/**
 * pi's bash tool with the extra argument. `operations` is what the foreground
 * tool was built with, so a background command is confined the same way; its
 * own `spawn` would make `background: true` a way out of the sandbox.
 */
export function withBackgroundOption<T extends BashLikeDefinition>(
  definition: T,
  cwd: string,
  operations: OperationsLike
): T {
  return {
    ...definition,
    description: `${definition.description}\n${TIMEOUT_GUIDANCE}\n${BACKGROUND_GUIDANCE}`,
    parameters: Type.Object({
      ...definition.parameters.properties,
      // pi's own text says "no default timeout"; tool-timeouts makes that
      // false.
      timeout: Type.Optional(
        Type.Number({
          description:
            "Seconds to allow, up to 600 (1800 for an install or a scaffold). Unset means " +
            "120, or 1800 for an install or a scaffold, which are recognised by their command.",
        })
      ),
      background: Type.Optional(
        Type.Boolean({
          description:
            "Run it in the background and return straight away. If it finishes before your reply " +
            "is done you are told. Use for long work; leave unset for anything you need the " +
            "output of now.",
        })
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (params.background !== true) {
        // `background` is dropped, not forwarded: pi validates its own schema.
        const { background: _background, ...forwarded } = params;

        return definition.execute(toolCallId, forwarded, signal, onUpdate, ctx);
      }

      const command =
        typeof params.command === "string" ? params.command.trim() : "";

      if (command.length === 0) {
        return {
          content: [{ type: "text" as const, text: "A command is required." }],
          details: {},
          isError: true,
        };
      }

      const job = startBackgroundJob({
        command,
        cwd,
        operations,
        // tool-timeouts leaves background calls unstamped; any deadline here
        // was asked for.
        ...(typeof params.timeout === "number" && params.timeout > 0
          ? { timeout: params.timeout }
          : {}),
        notifyOnExit: true,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Started ${job.id} in the background: ${command}`,
              "",
              "Carry on with something else. If it finishes while you work you are told, with its",
              "output; after your reply the user is told, and you hear with their next message.",
              `Stop it early with kill_process id:"${job.id}".`,
            ].join("\n"),
          },
        ],
        details: { backgroundJobId: job.id },
      };
    },
  } as T;
}
