/**
 * Commands that outlive the tool call that started them. One registry, because
 * the thing to get right is that nothing this agent spawned survives it (a
 * detached `npm run dev` holds its port until reboot). Jobs run through
 * `BashOperations`, the foreground `bash` seam, so they stay confined and every
 * backend's `options.signal` teardown is the one stop button.
 */
import type { BashOperations } from "@earendil-works/pi-coding-agent";

/** Kept small: this is "did it work", not a log aggregator. */
const MAX_OUTPUT_BYTES = 64_000;

export interface BackgroundExit {
  code: number | null;
  /** Set when the job was stopped by us rather than finishing on its own. */
  killed: boolean;
}

export interface BackgroundJob {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  output: string;
  exit: BackgroundExit | null;
  /**
   * Whether finishing wakes the agent: true for `bash background`, false for a
   * dev server.
   */
  notifyOnExit: boolean;
}

interface Tracked extends BackgroundJob {
  controller: AbortController;
}

type SettledListener = (job: BackgroundJob) => void;

const jobs = new Map<string, Tracked>();
const listeners = new Set<SettledListener>();
let counter = 0;

const snapshot = (job: Tracked): BackgroundJob => ({
  id: job.id,
  command: job.command,
  cwd: job.cwd,
  startedAt: job.startedAt,
  output: job.output,
  exit: job.exit,
  notifyOnExit: job.notifyOnExit,
});

/**
 * Be told when a job finishes. Waking the agent needs pi's `sendMessage`, which
 * only an extension holds, so the registry owns processes and this is the seam.
 */
export function onBackgroundJobSettled(listener: SettledListener): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

/**
 * The conversation queue was emptied, so anything handed to it is gone. Stop
 * clears pi's queue on purpose, but a finished job's news may be in it, and pi
 * has no event or inspection for that, so the code doing the clearing says so.
 */
const queueClearedListeners = new Set<() => void>();

export function onConversationQueueCleared(listener: () => void): () => void {
  queueClearedListeners.add(listener);

  return () => queueClearedListeners.delete(listener);
}

export function notifyConversationQueueCleared(): void {
  for (const listener of queueClearedListeners) {
    try {
      listener();
    } catch {
      /* one bad listener must not stop the rest being told */
    }
  }
}

export function listBackgroundJobs(): BackgroundJob[] {
  return [...jobs.values()].map(snapshot);
}

export function getBackgroundJob(id: string): BackgroundJob | undefined {
  const job = jobs.get(id);

  return job == null ? undefined : snapshot(job);
}

/** True when the job existed and was still running. */
export function killBackgroundJob(id: string): boolean {
  const job = jobs.get(id);

  if (job == null || job.exit != null) return false;

  job.exit = { code: null, killed: true };
  job.controller.abort();

  return true;
}

/** Stop everything. Returns the ids that were actually still running. */
export function killAllBackgroundJobs(): string[] {
  const stopped: string[] = [];

  // The spread is the point: the body deletes from the collection being
  // iterated, so this snapshots the keys first.
  // oxlint-disable-next-line unicorn/no-useless-spread
  for (const id of [...jobs.keys()]) {
    if (killBackgroundJob(id)) stopped.push(id);
  }

  return stopped;
}

/** Kill a job and forget it, so its id stops being a thing that can be read. */
export function removeBackgroundJob(id: string): boolean {
  if (!jobs.has(id)) return false;

  killBackgroundJob(id);
  jobs.delete(id);

  return true;
}

/** Only for tests: forget finished jobs so ids and state do not leak between them. */
export function resetBackgroundJobs(): void {
  killAllBackgroundJobs();
  jobs.clear();
  counter = 0;
}

/**
 * A foreground child that must not outlive the agent: SIGTERM mid tool call
 * would otherwise strand a process group or a docker container.
 */
export interface ForegroundProcess {
  /** Synchronous kill: must be safe inside a process 'exit' handler. */
  kill: () => void;
  /** Teardown that spawns (e.g. `docker kill`); skipped on 'exit', where the
   *  event loop is gone and nothing can spawn. */
  spawnCleanup?: () => void;
}

const foreground = new Set<ForegroundProcess>();

/** Track a foreground child until it exits. Returns the deregistration. */
export function registerForegroundProcess(
  entry: ForegroundProcess
): () => void {
  installExitCleanup();
  foreground.add(entry);

  return () => foreground.delete(entry);
}

/** Kill every registered foreground child. */
export function killAllForegroundProcesses(options: {
  spawnCleanup: boolean;
}): void {
  for (const entry of foreground) {
    try {
      if (options.spawnCleanup) entry.spawnCleanup?.();
      entry.kill();
    } catch {
      /* already gone */
    }
  }

  foreground.clear();
}

export function startBackgroundJob(options: {
  command: string;
  cwd: string;
  operations: BashOperations;
  /** Seconds. Omitted means no deadline, which is the point of backgrounding. */
  timeout?: number;
  notifyOnExit: boolean;
}): BackgroundJob {
  installExitCleanup();

  const id = `bg-${++counter}`;
  const controller = new AbortController();
  const job: Tracked = {
    id,
    command: options.command,
    cwd: options.cwd,
    startedAt: Date.now(),
    output: "",
    exit: null,
    notifyOnExit: options.notifyOnExit,
    controller,
  };

  jobs.set(id, job);

  const settle = (exit: BackgroundExit): void => {
    // A kill already recorded "stopped"; its own exit code must not overwrite
    // it.
    job.exit ??= exit;

    // A job forgotten while running must not report in afterwards. By identity,
    // not id: a dropped job dies asynchronously and its last gasp can arrive
    // after something else has taken the id.
    if (jobs.get(job.id) !== job) return;

    for (const listener of listeners) {
      try {
        listener(snapshot(job));
      } catch {
        /* a listener that throws must not take down the others, or the job */
      }
    }
  };

  void options.operations
    .exec(options.command, options.cwd, {
      onData: (data: Buffer) => {
        job.output = (job.output + data.toString()).slice(-MAX_OUTPUT_BYTES);
      },
      signal: controller.signal,
      ...(options.timeout != null ? { timeout: options.timeout } : {}),
    })
    .then(({ exitCode }) => settle({ code: exitCode, killed: false }))
    .catch((error: unknown) => {
      // pi's local backend throws `aborted` on the signal: our own stop, not a
      // failure.
      const aborted = controller.signal.aborted;

      if (!aborted) {
        job.output = `${job.output}\n${error instanceof Error ? error.message : String(error)}`;
      }

      settle({ code: null, killed: aborted });
    });

  return snapshot(job);
}

/**
 * Kill everything this process started, on every way out that allows it. `exit`
 * alone misses signals, and the desktop stops a session with SIGTERM. SIGINT is
 * deliberately not handled: the terminal client binds it to "stop this turn"
 * and a second press exits through `process.exit`, which fires `exit`.
 */
let cleanupInstalled = false;

function installExitCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;

  process.on("exit", () => {
    killAllBackgroundJobs();
    killAllForegroundProcesses({ spawnCleanup: false });
  });

  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    const onSignal = (): void => {
      killAllBackgroundJobs();
      killAllForegroundProcesses({ spawnCleanup: true });

      // Any listener suppresses Node's default (terminate); re-raising with
      // only
      // this handler removed restores it without taking anyone else's listener.
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    };

    process.on(signal, onSignal);
  }
}
