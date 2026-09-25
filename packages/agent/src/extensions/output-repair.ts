/**
 * Ported from codingagent-lite (abacusai/codingagent-lite), MIT; only the
 * env-var prefix changed (CALITE_* -> ABACUSAI_BOT_*).
 *
 * Output repair: cheap models emit tool calls as fenced text, return empty
 * responses, or call tools that don't exist, each of which stalls a run. A
 * corrective message steers the run back, capped so a confused model cannot
 * ping-pong with the repair loop forever.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_NUDGES_PER_SESSION = 6;
// Six nudges on one prompt is not coaxing, it is a loop the user is watching.
const MAX_NUDGES_PER_PROMPT = 2;

const FENCED_TOOL_CALL_PATTERNS: RegExp[] = [
  // ```json { "name": "...", "arguments": ... }: a tool call written as text
  /```[a-z_]*\s*\{[^`]{0,400}"(?:name|tool|tool_name|function)"\s*:/i,
  // XML-ish pseudo tool-call tags various models fall back to
  /<(?:tool_call|function_call|invoke|tool)\b/i,
  /\[TOOL_(?:CALL|REQUEST)\]/i,
  // Fence labels and chat-template tokens that only ever introduce a tool call.
  /```tool_(?:code|calls?)/i,
  /<\|(?:python_tag|tool_call)\|>/i,
  // A bare JSON object with no fence. Requiring both a name-ish and an
  // arguments-ish key keeps a JSON answer that merely has a "name" from tripping.
  /^\s*\{[\s\S]{0,400}"(?:name|tool|tool_name|function)"\s*:[\s\S]{0,600}"(?:arguments|parameters|input|args)"\s*:/,
];

function levenshtein(a: string, b: string): number {
  // Flat-row DP: the array-of-arrays version trips `noUncheckedIndexedAccess`.
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i++) {
    const current = [i, ...Array.from<number>({ length: b.length }).fill(0)];

    for (let j = 1; j <= b.length; j++) {
      const substitution =
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        substitution
      );
    }

    previous = current;
  }

  return previous[b.length] as number;
}

export default function (pi: ExtensionAPI) {
  let nudges = 0;
  let nudgesThisPrompt = 0;
  // Captured at turn_start: an AbortSignal keeps `aborted` set after the fact,
  // whereas ctx.signal is cleared once the agent stops streaming.
  let turnSignal: AbortSignal | undefined;

  const nudge = (text: string) => {
    if (
      nudges >= MAX_NUDGES_PER_SESSION ||
      nudgesThisPrompt >= MAX_NUDGES_PER_PROMPT
    )
      return;
    nudges++;
    nudgesThisPrompt++;
    pi.sendMessage(
      { customType: "calite-output-repair", content: text, display: true },
      { deliverAs: "followUp", triggerTurn: true }
    );
  };

  // A fresh prompt resets the per-prompt budget only: a model that needs
  // repairing all conversation long is not fixed by more of the same.
  pi.on("input", () => {
    nudgesThisPrompt = 0;
  });

  pi.on("turn_start", (_event, ctx) => {
    turnSignal = ctx.signal;
  });

  pi.on("turn_end", async (event, ctx) => {
    // A truncated or empty message is the expected result of an interrupt;
    // nudging would restart the very work the user just stopped.
    const aborted =
      turnSignal?.aborted === true || ctx.signal?.aborted === true;
    turnSignal = undefined;
    if (aborted) return;

    const msg = event.message;
    if (
      !("role" in msg) ||
      msg.role !== "assistant" ||
      !Array.isArray(msg.content)
    )
      return;

    // An empty message is only a model failure when the provider call
    // succeeded. "error" (pi retries it itself) and "aborted" both arrive with
    // no content; nudging on them lands after pi's retry has already produced
    // the real answer, and repeats it once per failed request.
    const stopReason = (msg as { stopReason?: string }).stopReason;
    if (stopReason === "error" || stopReason === "aborted") return;
    const hasToolCall = msg.content.some((b) => b.type === "toolCall");
    if (hasToolCall) return;

    const text = msg.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (text.length === 0) {
      nudge(
        "Your last response was empty. Continue the task: either call a tool or state your final answer in plain text."
      );
      return;
    }

    if (FENCED_TOOL_CALL_PATTERNS.some((re) => re.test(text))) {
      nudge(
        "It looks like you wrote a tool call as text instead of invoking it. " +
          "Text output is never executed. Re-issue the call using native tool calling."
      );
    }
  });

  /** The advice, or null when this is not an unknown-tool error worth answering. */
  const unknownToolAdvice = (toolName: string, text: string): string | null => {
    if (
      !/unknown tool|not a valid tool|no such tool|tool .{0,40}(?:not found|does not exist)/i.test(
        text
      )
    )
      return null;

    const names = pi.getAllTools().map((t) => t.name);
    if (names.length === 0) return null;
    // Hallucinated names are usually a real tool plus a prefix/suffix
    // (read_file): containment first, then edit distance.
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const wanted = norm(toolName);
    const contained = names.find(
      (n) => wanted.includes(norm(n)) || norm(n).includes(wanted)
    );
    const closest = names
      .map((n) => ({
        n,
        d: levenshtein(toolName.toLowerCase(), n.toLowerCase()),
      }))
      .sort((a, b) => a.d - b.d)[0];
    const best =
      contained ?? (closest && closest.d <= 4 ? closest.n : undefined);
    const suggestion = best ? ` Did you mean \`${best}\`?` : "";

    return `Available tools: ${names.join(", ")}.${suggestion}`;
  };

  const textOf = (content: unknown): string =>
    Array.isArray(content)
      ? content
          .filter(
            (b): b is { type: "text"; text: string } =>
              typeof b === "object" &&
              b != null &&
              (b as { type?: unknown }).type === "text"
          )
          .map((b) => b.text)
          .join(" ")
      : typeof content === "string"
        ? content
        : "";

  /** Answered here already, so the `tool_execution_end` fallback stays quiet. */
  const answered = new Set<string>();

  // Unknown-tool errors: append the real tool list and the closest name.
  pi.on("tool_result", async (event) => {
    if (!event.isError) return;
    const advice = unknownToolAdvice(event.toolName, textOf(event.content));
    if (advice == null) return;

    answered.add(event.toolCallId);

    return {
      content: [...event.content, { type: "text" as const, text: advice }],
    };
  });

  /**
   * A name not in the registry never reaches `tool_result`: the agent loop
   * answers it from `prepareToolCall` with an "immediate" result that skips
   * the `afterToolCall` path. `tool_execution_end` does fire there but cannot
   * rewrite the result, so the advice goes back as a follow-up under the same
   * budget.
   */
  pi.on("tool_execution_end", async (event) => {
    if (!event.isError) return;
    if (answered.delete(event.toolCallId)) return;

    const advice = unknownToolAdvice(
      event.toolName,
      textOf(event.result?.content ?? event.result)
    );
    if (advice == null) return;

    nudge(`\`${event.toolName}\` is not a tool that exists. ${advice}`);
  });
}
