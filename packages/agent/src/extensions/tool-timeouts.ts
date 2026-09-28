/**
 * Tool-call budgets, enforced in one place so a command waiting on stdin
 * cannot park an unattended turn forever. Tools with a native timeout (bash)
 * get the budget stamped on the call and pi kills the process; everything else
 * gets a watchdog that can only report, since the extension API has no
 * per-call abort. Unknown tool names fall to DEFAULT_BUDGET_SECONDS.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Budget {
  seconds: number;
  /** The tool's own timeout parameter (seconds); present = self-enforced. */
  nativeParam?: string;
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
  pdf: { seconds: 300 },
  deck_export_pdf: { seconds: 300 },
  ast_edit: { seconds: 60 },
  // code_map bounds itself at 20s; the watchdog only catches a genuine hang.
  code_map: { seconds: 30 },
  read_output: { seconds: 15 },
  read: { seconds: 30 },
  write: { seconds: 30 },
  edit: { seconds: 30 },
  batch_edit: { seconds: 45 },
  batch_file_read: { seconds: 30 },
};

const DEFAULT_BUDGET_SECONDS = 180;

/** pi rejects a bash timeout above its own ceiling; stay well inside it. */
const MAX_STAMPED_SECONDS = 600;

/**
 * Commands that fetch a dependency tree and reliably want minutes: for an
 * install, slow IS the normal outcome, so these get the ceiling by default.
 * Not backgrounded, because the next step needs their files.
 */
const SLOW_COMMAND_PATTERN =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:i|add|install|ci|dlx|create)\b|\bnpx\b|\bcreate-(?:next|react|vite|expo|remix|t3)-app\b|\bpip3?\s+install\b|\buv\s+(?:pip\s+)?(?:install|sync)\b|\bpoetry\s+(?:install|add)\b|\bcargo\s+(?:build|install|fetch)\b|\bgo\s+(?:get|mod\s+download)\b|\bbundle\s+install\b|\bbrew\s+install\b|\bgit\s+clone\b|\bdocker\s+(?:build|pull)\b/;

/** What a killed command should tell the model to do about it. */
const TIMEOUT_REMEDY =
  "Re-run it with a larger `timeout` (up to 600 seconds). Use `background: true` " +
  "only for something you do not need the result of right now — never for an " +
  "install or a scaffold, because the next step needs its files.";

/** The budget a bash call gets when the model named none. */
export function bashBudgetSecondsFor(command: string): number {
  return SLOW_COMMAND_PATTERN.test(command)
    ? MAX_STAMPED_SECONDS
    : BUDGETS.bash!.seconds;
}

export function budgetSecondsFor(toolName: string): number {
  return BUDGETS[toolName]?.seconds ?? DEFAULT_BUDGET_SECONDS;
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

    // An explicit budget wins, but capped: it cannot park the session forever.
    if (
      typeof existing === "number" &&
      Number.isFinite(existing) &&
      existing > 0
    ) {
      if (existing > MAX_STAMPED_SECONDS)
        input[budget.nativeParam] = MAX_STAMPED_SECONDS;
      return;
    }

    const seconds =
      event.toolName === "bash"
        ? bashBudgetSecondsFor(String(input.command ?? ""))
        : budget.seconds;

    input[budget.nativeParam] = Math.min(seconds, MAX_STAMPED_SECONDS);
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    const budget = BUDGETS[event.toolName];
    // A tool that enforces its own deadline needs no watchdog on top.
    if (budget?.nativeParam) return;

    const seconds = budget?.seconds ?? DEFAULT_BUDGET_SECONDS;
    const entry: { timer: NodeJS.Timeout; overran: boolean } = {
      overran: false,
      timer: setTimeout(() => {
        entry.overran = true;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `AbacusAI Bot: ${event.toolName} has run past its ${seconds}s budget — still waiting`,
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
      if (/Command timed out after \d+ seconds/.test(text)) {
        return {
          content: [
            ...event.content,
            { type: "text" as const, text: `[${TIMEOUT_REMEDY}]` },
          ],
        };
      }
    }

    const entry = running.get(event.toolCallId);
    if (!entry) return;
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
