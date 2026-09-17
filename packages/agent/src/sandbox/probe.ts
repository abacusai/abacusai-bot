/**
 * Proving a backend confines before trusting it: a control run that must
 * succeed, then a canary write outside the allowed paths that must fail.
 * One cannot tell "the write was refused" from "no sandbox could be made"
 * without the control. A timeout is no verdict either way.
 */
import { execFileSync } from "node:child_process";

export type ProbeStatus = number | "timeout" | null;

/** Runs argv and reports its exit status; the default uses execFileSync. */
export type ProbeExec = (argv: string[]) => ProbeStatus;

/**
 * Long enough for a container on a busy machine; short enough that a runner
 * that hangs (a Windows without container support) does not stall the
 * first command for long. A timeout is remembered by the callers, so it is
 * paid once per process.
 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * execFileSync enforces the deadline with SIGTERM, so that signal is the
 * timeout evidence. Any other signal is a real verdict about this host.
 */
export function execFailureStatus(failure: {
  code?: string;
  status?: number | null;
  signal?: NodeJS.Signals | null;
}): ProbeStatus {
  if (failure.code === "ETIMEDOUT" || failure.signal === "SIGTERM")
    return "timeout";

  return typeof failure.status === "number" ? failure.status : null;
}

export const execStatus: ProbeExec = (argv) => {
  try {
    execFileSync(argv[0]!, argv.slice(1), {
      stdio: "ignore",
      timeout: PROBE_TIMEOUT_MS,
    });

    return 0;
  } catch (error) {
    return execFailureStatus(
      error as NodeJS.ErrnoException & {
        status?: number | null;
        signal?: NodeJS.Signals | null;
      }
    );
  }
};

/**
 * True when the control ran and the canary was refused; false when either
 * says the sandbox does not hold; null when a run timed out.
 */
export function probeVerdict(
  control: string[],
  canary: string[],
  exec: ProbeExec = execStatus
): boolean | null {
  const first = exec(control);
  if (first === "timeout") return null;
  if (first !== 0) return false;

  const second = exec(canary);
  if (second === "timeout") return null;

  return second !== null && second !== 0;
}
