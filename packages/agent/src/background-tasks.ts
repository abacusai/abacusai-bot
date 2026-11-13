/**
 * What is still running past its turn, as the user sees it above the chat
 * box: each background job with its label, how long it has run, its last
 * output line and how far it says it has got, and each served page.
 */
import {
  killBackgroundJob,
  listBackgroundJobs,
  notifyBackgroundActivity,
} from "./background-processes.js";
import type { BackgroundTask } from "./protocol.js";
import { listServed, stopDirectory } from "./static-server.js";
import { lastLine, progressOf } from "./terminal-progress.js";

/** Enough of a job's output for its last line and its progress. */
const TAIL_BYTES = 4_000;

/** One line for a narrow strip. */
const LINE_MAX = 200;

const short = (line: string): string =>
  line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;

/** The id a served page is stopped by, beside a job's own `bg-n`. */
const servedTaskId = (port: number): string => `serve:${port}`;

/** Stop one task by its id. True when it was running and now is not. */
export const stopBackgroundTask = (id: string): boolean => {
  if (killBackgroundJob(id)) return true;
  const served = listServed().find((entry) => servedTaskId(entry.port) === id);
  if (served == null || !stopDirectory(served.directory)) return false;
  notifyBackgroundActivity();
  return true;
};

export const backgroundTasks = (): BackgroundTask[] => [
  ...listBackgroundJobs()
    .filter((job) => job.exit == null)
    .map((job): BackgroundTask => {
      const tail = job.output.slice(-TAIL_BYTES);
      return {
        id: job.id,
        kind: "job",
        label: job.label,
        command: job.command,
        startedAt: job.startedAt,
        lastOutputAt: job.lastOutputAt,
        lastLine: short(lastLine(tail)),
        progress: progressOf(tail),
      };
    }),
  ...listServed().map((served): BackgroundTask => ({
    id: servedTaskId(served.port),
    kind: "serve",
    label: null,
    command: served.url,
    startedAt: null,
    lastOutputAt: null,
    lastLine: "",
    progress: null,
  })),
];
