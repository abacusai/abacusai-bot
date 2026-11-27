/**
 * `bash` with `background: true`: the same command, but the call returns once
 * it is running and the result is delivered later (extensions/background.ts),
 * so a deadline never kills a twenty-minute build. Wraps pi's own definition
 * rather than replacing it; foreground calls go straight to pi untouched.
 */
import { Type } from "typebox";

import {
  type BackgroundJob,
  listBackgroundJobs,
  startBackgroundJob,
} from "./background-processes.js";
import { screenText } from "./terminal-progress.js";

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
  "plainly that it is still running and what they should expect. To wait for it, call",
  "fetch_background_output with its id and wait_seconds: it returns as soon as it finishes, the",
  "user watches its output meanwhile, and a message from the user ends the wait early. Never wait",
  "with sleep.",
  "",
  "A background run has no deadline unless you set timeout, and a timeout stops it: never set",
  "one on a server. Stop one early with kill_process. For a static page use serve instead.",
].join("\n");

/**
 * The user watches long work as it runs: the row shows the label and the
 * command's live output, and a backgrounded job stays listed above the chat
 * box until it ends. Redrawn progress lines reach the model as their last state.
 */
const VISIBILITY_GUIDANCE = [
  "",
  "Set label for anything that may take more than a few seconds: what it does, in a few words",
  'of the user\'s language ("Downloading Flutter, 1.8 GB", "Installing the app\'s packages").',
  "The user sees it while the command runs. Never silence a download, install or build",
  "(curl -s, -q, --quiet, > /dev/null): its progress is how the user sees it is moving, and",
  "only each progress line's final state reaches you, so it costs you nothing.",
].join("\n");

/**
 * A command that opens with a sleep of this long or more, while a job of
 * ours runs in the background, is a blind poll of that job: the user sees
 * nothing and their messages wait behind it. It is answered with the way to
 * wait instead (fetch_background_output's wait_seconds).
 */
const POLL_SLEEP_SECONDS = 15;

/** A leading `sleep N` (after an optional `cd ... &&`), in seconds; null when there is none. */
export const leadingSleepSeconds = (command: string): number | null => {
  const match =
    /^\s*(?:cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*)?sleep\s+(\d+(?:\.\d+)?)([smhd]?)(?=$|[\s;&|])/.exec(
      command
    );
  if (match == null) return null;
  const unit = { "": 1, s: 1, m: 60, h: 3_600, d: 86_400 }[match[2] ?? ""] ?? 1;
  return Number(match[1]) * unit;
};

/** Words that say nothing about which job a check is for. */
const CHECK_WORDS = new Set(
  (
    "sleep echo printf tail head cat grep egrep less more curl wget http https localhost " +
    "true false done then else test ls dir find wc sed awk sort uniq cut tr xargs exit null " +
    "dev tmp tmpdir 127.0.0.1 0.0.0.0 -s -sS -m -c -n -f -i"
  ).split(" ")
);

/**
 * The running jobs a check after the sleep is plausibly about: one whose
 * command, label or recent output names a file, folder, port or word the check
 * names (`sleep 60; tail install.log` and a job writing install.log).
 */
export const jobsTheCheckNames = (
  command: string,
  jobs: readonly BackgroundJob[]
): BackgroundJob[] => {
  const check = command.replace(/^[\s\S]*?sleep\s+\S+/, "");
  const words = [...check.matchAll(/[A-Za-z0-9_.:-]{3,}/g)]
    .map((match) => match[0]!.toLowerCase().replace(/^[.:-]+|[.:-]+$/g, ""))
    .filter((word) => word.length >= 3 && !CHECK_WORDS.has(word));
  return jobs.filter((job) => {
    const seen =
      `${job.command}\n${job.label ?? ""}\n${job.output.slice(-4_000)}`.toLowerCase();
    return words.some((word) => seen.includes(word));
  });
};

/** The answer to a blind poll: how to wait instead, naming the job it is plausibly for. */
const pollRefusal = (related: BackgroundJob | null): string =>
  related != null
    ? [
        `Not run: ${related.id} is still running in the background, and a sleep shows the user nothing`,
        "and holds their messages until it ends. To wait for it, call fetch_background_output with",
        `id:"${related.id}" and wait_seconds (up to 120); add until with a line you expect in its output`,
        "(checked against what it already printed too). It returns as soon as the job finishes or the",
        "line is there, shows its output to the user meanwhile, and ends early when the user writes.",
        "Then run the check you meant to run after the sleep.",
      ].join("\n")
    : [
        "Not run: a sleep shows the user nothing and holds their messages until it ends. To wait, call",
        "fetch_background_output with wait_seconds (up to 120) and no id: it waits the same time, but",
        "ends early when the user writes or a background job finishes, and shows the running jobs'",
        "output meanwhile. Then run the check you meant to run after the sleep.",
      ].join("\n");

/** A short, plain title for the user; never the command itself. */
const LABEL_MAX = 80;

const labelOf = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const label = value.replace(/\s+/g, " ").trim();
  if (label === "") return null;
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
};

interface ResultLike {
  content?: Array<{ type: string; text?: string }>;
  [key: string]: unknown;
}

/** The result as the model reads it: each redrawn line at its last state. */
const collapsedResult = (result: unknown): unknown => {
  const typed = result as ResultLike | null;
  if (typed == null || !Array.isArray(typed.content)) return result;
  return {
    ...typed,
    content: typed.content.map((part) =>
      part.type === "text" && typeof part.text === "string"
        ? { ...part, text: screenText(part.text) }
        : part
    ),
  };
};

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
    description: `${definition.description}\n${TIMEOUT_GUIDANCE}\n${BACKGROUND_GUIDANCE}\n${VISIBILITY_GUIDANCE}`,
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
      label: Type.Optional(
        Type.String({
          description:
            "What this does, in a few words of the user's language. Shown to the user while it runs.",
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
        const command =
          typeof params.command === "string" ? params.command : "";
        const sleep = leadingSleepSeconds(command);
        const running = listBackgroundJobs().filter((job) => job.exit == null);
        if (sleep != null && sleep >= POLL_SLEEP_SECONDS && running.length > 0)
          return {
            content: [
              {
                type: "text" as const,
                text: pollRefusal(
                  jobsTheCheckNames(command, running)[0] ?? null
                ),
              },
            ],
            details: {},
            isError: true,
          };
        // `background` and `label` are dropped, not forwarded: pi validates
        // its own schema.
        const { background: _background, label: _label, ...forwarded } = params;

        return collapsedResult(
          await definition.execute(toolCallId, forwarded, signal, onUpdate, ctx)
        );
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
        label: labelOf(params.label),
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
              `To wait for it, call fetch_background_output id:"${job.id}" with wait_seconds; never sleep.`,
              `Stop it early with kill_process id:"${job.id}".`,
            ].join("\n"),
          },
        ],
        details: { backgroundJobId: job.id },
      };
    },
  } as T;
}
