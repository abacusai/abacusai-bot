/**
 * Ported from codingagent-lite (abacusai/codingagent-lite), MIT.
 *
 * Outer verification loop: after a turn that wrote files, the session runs the
 * project's tests before it closes the turn (AbacusBotSession.verifyTurn). A
 * test this turn broke goes back to the model as a follow-up, at most
 * ABACUSAI_BOT_VERIFY_RETRIES times per user message (default 1), each limited
 * to ABACUSAI_BOT_VERIFY_CALLS model calls (default 20). It belongs to the
 * turn so the follow-up is part of the user's run: drawn in the chat, kept in
 * the transcript, and ended by Stop.
 *
 * What "this turn broke" means: the suite is green, or every failing test also
 * fails on the project as it stood before the turn (verify-baseline.ts). That
 * second run happens only on a red suite, so a green one costs a single run.
 * Anything short of a per-test answer sends nothing: a suite that could not
 * run at all (a missing dependency, a broken config) says nothing here, and
 * one that failed in a way that can't be attributed gets one line in the chat.
 * Uses run_tests' detector so the two cannot drift.
 */
import { stripVTControlCharacters } from "node:util";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { execConfined } from "../backends.js";
import { currentMode } from "../current-mode.js";
import { toolPath, WRITE_TOOLS } from "../permissions.js";
import { AgentMode } from "../protocol.js";
import { runFallbackShell } from "../sandbox/shell.js";
import type { RunLimit } from "./budgets.js";
import type { Framework } from "./test-runner.js";
import { detectFramework } from "./test-runner.js";
import { inPreTurnTree, PreImages } from "./verify-baseline.js";

/**
 * How many follow-ups this loop may send per user prompt. A malformed value
 * must not become NaN (`retriesUsed >= NaN` never stops the loop) and a blank
 * one must mean unset, not 0.
 */
export const resolveMaxRetries = (raw: string | undefined): number => {
  const trimmed = (raw ?? "").trim();

  if (trimmed.length === 0) return 1;

  const parsed = Number(trimmed);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
};

/** Model calls one follow-up may make. Zero is no limit, so it means unset. */
export const resolveMaxCalls = (raw: string | undefined): number => {
  const parsed = Math.floor(Number(raw));

  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
};

const SUITE_TIMEOUT_MS = 300_000;
/**
 * The baseline run gets a few times what the suite just took, within a range
 * that keeps both runs under the app's ten minutes of turn inactivity.
 */
const BASELINE_MIN_TIMEOUT_MS = 60_000;
const BASELINE_MAX_TIMEOUT_MS = 240_000;
const BASELINE_TIMEOUT_FACTOR = 3;
const OUTPUT_TAIL_CHARS = 3_000;
const FAILURES_LISTED = 20;
/** Commands that change or discard work this turn did not do. */
const DISCARDS_WORK =
  /\bgit\b[^|;&\n]*\s(?:stash|reset|checkout|clean|restore)\b/;

export type Verdict =
  /** Nothing for the chat: green, or the suite could not say anything. */
  | { kind: "clear" }
  /** Red, and whether this turn did it can't be told. */
  | { kind: "left-alone" }
  /** This turn broke tests: send `prompt`. */
  | { kind: "repair"; prompt: string };

const CLEAR: Verdict = { kind: "clear" };

interface SuiteRun {
  output: string;
  code: number;
  timedOut: boolean;
  ms: number;
}

/**
 * The command comes from project config, so never the unconfined path; without
 * a sandbox backend it falls back to the platform shell.
 */
async function runSuite(
  command: string,
  cwd: string,
  timeout: number,
  signal: AbortSignal
): Promise<SuiteRun> {
  const started = Date.now();

  try {
    const result =
      (await execConfined(command, cwd, { timeout, signal })) ??
      (await runFallbackShell(command, cwd, { timeout, signal }));

    return {
      output: stripVTControlCharacters(
        `${result.stdout}\n${result.stderr}`
      ).trim(),
      code: result.code,
      timedOut: result.killed,
      ms: Date.now() - started,
    };
  } catch (error) {
    // The sandbox backend rejects on a timeout or an abort.
    return {
      output: String(error),
      code: 1,
      timedOut: true,
      ms: Date.now() - started,
    };
  }
}

const repairPrompt = (
  framework: Framework,
  broken: readonly string[],
  output: string
): string => {
  const listed = broken.slice(0, FAILURES_LISTED).map((id) => `- ${id}`);
  const more = broken.length - listed.length;

  return (
    `Independent verification ran the project's test suite (${framework.name}) after you finished. ` +
    "This message comes from the app, not from the user. These tests pass on the project as it was " +
    `before this turn and fail now, so this turn's changes broke them:\n\n${listed.join("\n")}` +
    `${more > 0 ? `\n- and ${more} more` : ""}\n\n` +
    `The end of the test output:\n\n${output.slice(-OUTPUT_TAIL_CHARS)}\n\n` +
    "Fix these failures and only these: change what this turn changed, in the implementation. Do not " +
    "weaken or skip a test. Leave any other failing test alone: it was failing before you started. " +
    "Do not run git stash, git reset, git checkout, git restore, git clean or anything else that " +
    "changes or discards work that is not yours from this turn. If the fix is not a small one, stop " +
    "and tell the user what broke instead. Then tell the user, in their language, in a sentence or " +
    "two, what broke and what you did."
  );
};

/** The loop's state and the hooks it needs; see AbacusBotSession.verifyTurn. */
export class VerifyLoop {
  /** The budget extension enforces this; `beginRepair` arms it. */
  readonly runLimit: RunLimit = { calls: null, used: 0, reached: false };
  private readonly maxRetries = resolveMaxRetries(
    process.env.ABACUSAI_BOT_VERIFY_RETRIES
  );
  private readonly maxCalls = resolveMaxCalls(
    process.env.ABACUSAI_BOT_VERIFY_CALLS
  );
  private readonly preImages = new PreImages();
  private wroteFiles = false;
  private retriesUsed = 0;
  /** What failed before this turn; null until a red suite needed it. */
  private baseline: ReadonlySet<string> | null = null;
  /** The chat was told once this session; it would say the same every turn. */
  private toldLeftAlone = false;
  /** Timed out once: not again, or every turn ends on a five-minute wait. */
  private suiteTooSlow = false;
  private repairing = false;
  private checking: AbortController | null = null;

  readonly extension = (pi: ExtensionAPI): void => {
    pi.on("input", (event) => {
      // Only the user's own message starts a new budget. A message an extension
      // sent, or one joining the run under way, belongs to the same prompt.
      if (event.source === "extension" || event.streamingBehavior != null)
        return;
      this.retriesUsed = 0;
      this.wroteFiles = false;
      this.baseline = null;
      this.preImages.clear();
    });

    pi.on("tool_call", (event, ctx) => {
      if (this.repairing && event.toolName === "bash") {
        const command = String((event.input as { command?: unknown }).command);

        if (DISCARDS_WORK.test(command))
          return {
            block: true,
            reason:
              "Not while repairing tests: this command changes or discards work that is not yours " +
              "from this turn. Fix what this turn broke by editing those files.",
          };
      }
      if (!WRITE_TOOLS.has(event.toolName)) return undefined;
      const input = event.input as { path?: unknown; notebookPath?: unknown };
      const file = toolPath(String(input.path ?? input.notebookPath), ctx.cwd);

      if (file == null) this.preImages.lose();
      else this.preImages.note(file);

      return undefined;
    });

    pi.on("tool_result", (event) => {
      if (WRITE_TOOLS.has(event.toolName) && !event.isError)
        this.wroteFiles = true;
    });
  };

  /** Whether the project's tests have anything to say about this turn. */
  private due(): boolean {
    // Running the test command is arbitrary code execution with no tool call
    // to decline, so only in modes where commands may run unprompted. A routine
    // is Unattended, and a hosted session may have nobody watching: neither
    // gets work it did not ask for.
    const mode = currentMode();

    return (
      (mode === AgentMode.AcceptEdits ||
        mode === AgentMode.Auto ||
        mode === AgentMode.Yolo) &&
      process.env.ABACUSAI_BOT_CLIENT_KIND !== "web_host" &&
      this.wroteFiles &&
      this.retriesUsed < this.maxRetries &&
      !this.suiteTooSlow
    );
  }

  /** Stop, or a message from the user: the check ends, and nothing follows it. */
  cancel(): void {
    this.checking?.abort();
  }

  /** Runs the tests and says what the turn should do about them. */
  async check(cwd: string): Promise<Verdict> {
    if (!this.due()) return CLEAR;
    const framework = detectFramework(cwd);

    if (framework == null) return CLEAR;
    const checking = new AbortController();

    this.checking = checking;
    try {
      return await this.judge(framework, cwd, checking.signal);
    } finally {
      this.checking = null;
    }
  }

  private async judge(
    framework: Framework,
    cwd: string,
    signal: AbortSignal
  ): Promise<Verdict> {
    const command = framework.command();
    const suite = await runSuite(command, cwd, SUITE_TIMEOUT_MS, signal);

    if (signal.aborted || suite.code === 0) return CLEAR;
    if (suite.timedOut) {
      this.suiteTooSlow = true;
      this.log(`${framework.name} timed out; not running it again`);

      return CLEAR;
    }

    const failing = framework.failingTests?.(suite.output) ?? [];

    if (failing.length === 0) {
      // Red with no test named. Counts mean tests ran; without them the suite
      // never got that far (a missing dependency, a broken config).
      const counts = framework.parse(suite.output);
      const ran = (counts?.failed ?? 0) + (counts?.errors ?? 0) > 0;

      this.log(`${framework.name} exited ${suite.code} naming no test`);

      return ran ? this.leftAlone() : CLEAR;
    }

    const baseline = await this.baselineFor(framework, cwd, suite.ms, signal);

    if (signal.aborted) return CLEAR;
    if (baseline == null) {
      this.log(`${framework.name}: no baseline to compare with`);

      return this.leftAlone();
    }

    const broken = failing.filter((id) => !baseline.has(id));

    if (broken.length === 0) return CLEAR;
    this.retriesUsed += 1;

    return {
      kind: "repair",
      prompt: repairPrompt(framework, broken, suite.output),
    };
  }

  /** What failed before the turn: once per turn, as it cannot change. */
  private async baselineFor(
    framework: Framework,
    cwd: string,
    suiteMs: number,
    signal: AbortSignal
  ): Promise<ReadonlySet<string> | null> {
    if (this.baseline != null) return this.baseline;
    const timeout = Math.min(
      BASELINE_MAX_TIMEOUT_MS,
      Math.max(BASELINE_MIN_TIMEOUT_MS, suiteMs * BASELINE_TIMEOUT_FACTOR)
    );
    let run: SuiteRun | null;

    try {
      run = await inPreTurnTree(cwd, this.preImages, (tree) =>
        runSuite(framework.command(), tree, timeout, signal)
      );
    } catch (error) {
      this.log(`baseline copy failed: ${String(error)}`);

      return null;
    }
    if (run == null || run.timedOut) return null;
    const failed = framework.failingTests?.(run.output) ?? [];

    // Red with nothing named says nothing about any one test, nor does a run
    // that never tried them all.
    if (run.code !== 0 && failed.length === 0) return null;
    if (framework.stoppedEarly?.(run.output) === true) return null;
    this.baseline = new Set(failed);

    return this.baseline;
  }

  private leftAlone(): Verdict {
    if (this.toldLeftAlone) return CLEAR;
    this.toldLeftAlone = true;

    return { kind: "left-alone" };
  }

  private log(line: string): void {
    process.stderr.write(`[abacusai-bot-agent] verify loop: ${line}\n`);
  }

  beginRepair(): void {
    this.repairing = true;
    this.runLimit.calls = this.maxCalls;
    this.runLimit.used = 0;
    this.runLimit.reached = false;
  }

  /** The follow-up ended; true when it was stopped at its limit. */
  endRepair(): boolean {
    this.repairing = false;
    this.runLimit.calls = null;

    return this.runLimit.reached;
  }
}
