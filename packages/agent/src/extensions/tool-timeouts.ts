/**
 * Tool-call budgets: one table, held three ways.
 * - `bash` has a native timeout: the budget is stamped on the call and pi
 *   kills the process tree.
 * - A tool marked `stopped` here, and every MCP tool, runs under
 *   withCallBudget: its abort signal fires at the budget and the model gets a
 *   timeout result, so the turn goes on.
 * - Everything else (the sub-agent components, pi's own file tools) cannot be
 *   stopped from here; a watchdog only adds a note to the result.
 * Unknown names fall to DEFAULT_BUDGET_SECONDS, or MCP_DEFAULT_BUDGET_SECONDS
 * for an MCP tool.
 */
import type {
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

interface Budget {
  seconds: number;
  /** The tool's own timeout parameter (seconds); present = self-enforced. */
  nativeParam?: string;
  /** Held by withCallBudget, so the report-only watchdog leaves it alone. */
  stopped?: true;
}

/** `run_tests` is absent: it defaults to 300s and passes that to `pi.exec`. */
const BUDGETS: Record<string, Budget> = {
  bash: { seconds: 120, nativeParam: "timeout" },
  // The component tools each run a whole sub-agent session, so minutes is
  // their normal; each number is that component's own ceiling.
  browser_task: { seconds: 720 },
  document: { seconds: 900 },
  ppt: { seconds: 900 },
  design: { seconds: 900 },
  delegate_task: { seconds: 900 },
  // The app's MCP tools that do minutes of work behind one call: several
  // generation passes, or two or three providers tried in turn, each with
  // its own 120-180s deadline.
  pdf: { seconds: 300, stopped: true },
  deck_export_pdf: { seconds: 300, stopped: true },
  image_generate: { seconds: 360, stopped: true },
  text_to_speech: { seconds: 360, stopped: true },
  vision_analyze: { seconds: 360, stopped: true },
  video_analyze: { seconds: 360, stopped: true },
  bfl_flux3_get_result: { seconds: 240, stopped: true },
  // Its `wait` action may ask for two minutes; the browser server bounds
  // one call at 150s.
  browser_interact: { seconds: 150, stopped: true },
  ast_edit: { seconds: 60 },
  // code_map bounds itself at 20s; the watchdog only catches a genuine hang.
  code_map: { seconds: 30 },
  read_output: { seconds: 15 },
  read: { seconds: 30 },
  write: { seconds: 30 },
  edit: { seconds: 30 },
  batch_edit: { seconds: 45 },
  batch_file_read: { seconds: 30 },
  // The whole call, every provider tried included. web_fetch bounds itself.
  web_search: { seconds: 45, stopped: true },
  x_search: { seconds: 45, stopped: true },
};

const DEFAULT_BUDGET_SECONDS = 180;

/**
 * An MCP tool named nowhere above: a connector read or an app action, which
 * answers in seconds when it answers at all. Below DEFAULT_BUDGET_SECONDS, so
 * the watchdog's note never lands on a call that was stopped.
 */
const MCP_DEFAULT_BUDGET_SECONDS = 90;

/** The longest an explicit bash timeout may ask for. */
const MAX_STAMPED_SECONDS = 600;

/**
 * What an install or a scaffold gets, by default and at most: a package
 * manager on a slow network, or a Windows installer, runs for many minutes
 * and still succeeds. Past it the command is killed and the turn goes on with
 * what it printed.
 */
const INSTALL_SECONDS = 1_800;

/**
 * Commands that fetch a dependency tree or run an installer: for these, slow
 * IS the normal outcome, and they can go quiet for minutes while they work,
 * so neither their output nor its absence says whether they are stuck. Not
 * backgrounded, because the next step needs their files.
 */
const SLOW_COMMAND_PATTERN =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:i|add|install|ci|dlx|create)\b|\bnpx\b|\bcreate-(?:next|react|vite|expo|remix|t3)-app\b|\bpip3?\s+install\b|\buv\s+(?:pip\s+)?(?:install|sync)\b|\bpoetry\s+(?:install|add)\b|\bcargo\s+(?:build|install|fetch)\b|\bgo\s+(?:get|mod\s+download)\b|\bbundle\s+install\b|\bbrew\s+install\b|\bgit\s+clone\b|\bdocker\s+(?:build|pull)\b|\bwinget\s+(?:install|upgrade)\b|\bchoco\s+(?:install|upgrade)\b|\bscoop\s+install\b|\bcomposer\s+(?:install|require|create-project|update)\b|\b(?:apt|apt-get|dnf|yum)\s+install\b/;

/** What a bash call gets when it names no timeout, and the most it may ask for. */
function bashBudget(command: string): { seconds: number; ceiling: number } {
  return SLOW_COMMAND_PATTERN.test(command)
    ? { seconds: INSTALL_SECONDS, ceiling: INSTALL_SECONDS }
    : { seconds: BUDGETS.bash!.seconds, ceiling: MAX_STAMPED_SECONDS };
}

/** What a killed command should tell the model to do about it. */
function timeoutRemedy(command: string, killedAt: number): string {
  const { ceiling } = bashBudget(command);
  const next =
    killedAt < ceiling
      ? `Re-run it with a larger \`timeout\` (up to ${ceiling} seconds).`
      : `${ceiling} seconds is the most a command like this gets; split the work, or tell the user what did not finish.`;

  return (
    `${next} Use \`background: true\` only for something you do not need the ` +
    "result of right now; never for an install or a scaffold, because the next " +
    "step needs its files."
  );
}

export function budgetSecondsFor(toolName: string): number {
  return BUDGETS[toolName]?.seconds ?? DEFAULT_BUDGET_SECONDS;
}

/** How long an MCP tool's call may run before withCallBudget stops it. */
export function mcpCallBudgetSeconds(toolName: string): number {
  return BUDGETS[toolName]?.seconds ?? MCP_DEFAULT_BUDGET_SECONDS;
}

/** A tool as withCallBudget sees it: a name, and an execute taking a signal. */
interface StoppableTool {
  name: string;
  execute: (
    toolCallId: string,
    params: never,
    signal?: AbortSignal,
    ...rest: never[]
  ) => Promise<unknown>;
}

/**
 * `tool`, stopped at `seconds`. The signal its execute gets fires at Stop or
 * at the budget, whichever is first, so a tool that honours it (a fetch, an
 * MCP request, which also tells its server) stops its own work. The answer
 * does not wait for that: at the budget the call fails with a message the
 * model can act on, and the turn goes on.
 */
export function withCallBudget<TParams extends TSchema, TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>,
  seconds: number
): ToolDefinition<TParams, TDetails, TState>;
export function withCallBudget<T extends StoppableTool>(
  tool: T,
  seconds: number
): T;
export function withCallBudget(
  tool: StoppableTool,
  seconds: number
): StoppableTool {
  const execute = tool.execute;

  return {
    ...tool,
    execute: async (toolCallId, params, signal, ...rest) => {
      const deadline = new AbortController();
      const overrun = new Promise<never>((_resolve, reject) => {
        deadline.signal.addEventListener(
          "abort",
          () =>
            reject(
              new Error(
                `${tool.name} did not answer within ${seconds}s, so the call was stopped. ` +
                  "Carry on without it: try a narrower request or another way, or tell the user what could not be done."
              )
            ),
          { once: true }
        );
      });
      const timer = setTimeout(
        () =>
          deadline.abort(new Error(`the call's ${seconds}s budget ran out`)),
        seconds * 1_000
      );
      const callSignal =
        signal != null
          ? AbortSignal.any([signal, deadline.signal])
          : deadline.signal;
      try {
        return await Promise.race([
          execute(toolCallId, params, callSignal, ...rest),
          overrun,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export default function (pi: ExtensionAPI) {
  /** toolCallId -> the watchdog timer and whether it already fired. */
  const running = new Map<
    string,
    { timer: NodeJS.Timeout; overran: boolean }
  >();

  pi.on("tool_call", async (event) => {
    const budget = BUDGETS[event.toolName];
    if (!budget?.nativeParam) return;

    // The API's sanctioned way to adjust a call is mutating input in place.
    const input = event.input as Record<string, unknown>;

    // A backgrounded command escapes the deadline on purpose; stamping one
    // would kill a twenty-minute build at two minutes.
    if (input.background === true) return;

    const existing = input[budget.nativeParam];
    const { seconds, ceiling } =
      event.toolName === "bash"
        ? bashBudget(String(input.command ?? ""))
        : { seconds: budget.seconds, ceiling: MAX_STAMPED_SECONDS };

    // An explicit budget wins, but capped: it cannot park the session forever.
    if (
      typeof existing === "number" &&
      Number.isFinite(existing) &&
      existing > 0
    ) {
      if (existing > ceiling) input[budget.nativeParam] = ceiling;
      return;
    }

    input[budget.nativeParam] = Math.min(seconds, ceiling);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    const budget = BUDGETS[event.toolName];
    // A tool that is stopped at its budget needs no report on top.
    if (budget?.nativeParam != null || budget?.stopped === true) return;

    const seconds = budget?.seconds ?? DEFAULT_BUDGET_SECONDS;
    const entry: { timer: NodeJS.Timeout; overran: boolean } = {
      overran: false,
      timer: setTimeout(() => {
        entry.overran = true;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `AbacusAI Bot: ${event.toolName} has run past its ${seconds}s budget; still waiting`,
            "warning"
          );
        }
      }, seconds * 1_000),
    };
    // Never hold the process open for a watchdog.
    entry.timer.unref?.();
    running.set(event.toolCallId, entry);
  });

  pi.on("tool_execution_end", async (event) => {
    const entry = running.get(event.toolCallId);
    if (!entry) return;
    clearTimeout(entry.timer);
    // Keep the overran flag until tool_result reads it; turn_end sweeps up.
    if (!entry.overran) running.delete(event.toolCallId);
  });

  pi.on("tool_result", async (event) => {
    // pi's own timeout message gives the model no lead but retrying the same
    // command; say what would work instead.
    if (event.toolName === "bash") {
      const text = event.content
        .map((part) => ("text" in part ? part.text : ""))
        .join(" ");
      const killed = /Command timed out after (\d+) seconds/.exec(text);
      if (killed != null) {
        const remedy = timeoutRemedy(
          String(event.input.command ?? ""),
          Number(killed[1])
        );
        return {
          content: [
            ...event.content,
            { type: "text" as const, text: `[${remedy}]` },
          ],
        };
      }
    }

    const entry = running.get(event.toolCallId);
    if (!entry) return;
    // tool_result comes before tool_execution_end, which then finds nothing.
    clearTimeout(entry.timer);
    running.delete(event.toolCallId);
    if (!entry.overran) return;

    const seconds = budgetSecondsFor(event.toolName);
    return {
      content: [
        ...event.content,
        {
          type: "text" as const,
          text:
            `[This ${event.toolName} call took longer than its ${seconds}s budget. ` +
            `It completed, but treat it as expensive: narrow the input or choose a ` +
            `cheaper tool rather than repeating it.]`,
        },
      ],
    };
  });

  pi.on("turn_end", async () => {
    for (const entry of running.values()) clearTimeout(entry.timer);
    running.clear();
  });
}
