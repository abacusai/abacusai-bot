import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
/**
 * Shell commands that outlive the tool call, and the telling when they land.
 * A dev server is meant to stay up and is never waited on; a build run with
 * `bash background: true` does finish, and the agent should be interrupted
 * rather than poll. This extension holds pi's `sendMessage`, which the tool
 * cannot reach, and hands the finished job back as a follow-up.
 */
import { Type } from "typebox";

import {
  getBackgroundJob,
  killAllBackgroundJobs,
  killBackgroundJob,
  listBackgroundJobs,
  onBackgroundJobSettled,
  onConversationQueueCleared,
  type BackgroundJob,
} from "../background-processes.js";

/** Trimmed before it goes into the conversation: the tail is where the verdict is. */
const NOTIFY_OUTPUT_BYTES = 4_000;

const describe = (job: BackgroundJob): string => {
  const state =
    job.exit == null
      ? "running"
      : job.exit.killed
        ? "stopped"
        : `exited (code ${String(job.exit.code)})`;

  return `${job.id}  ${state}  ${job.command}`;
};

const tail = (output: string): string => {
  const trimmed = output.trim();

  if (trimmed.length <= NOTIFY_OUTPUT_BYTES) return trimmed;

  return `…(earlier output dropped)\n${trimmed.slice(-NOTIFY_OUTPUT_BYTES)}`;
};

export default function (pi: ExtensionAPI) {
  /**
   * Finished jobs the agent has not been told about yet. Held here rather than
   * in pi's queue because Stop clears that queue, and a build that finished as
   * the user pressed Stop would never be mentioned. A notice leaves only once
   * a turn starting proves it was consumed.
   */
  const pending: Array<{ id: string; text: string; sent: boolean }> = [];
  /** Something has been handed over and it is not yet known whether it landed. */
  let awaitingTurn = false;
  let busy = false;

  const flush = (): void => {
    // Not mid-turn, and not while an earlier handover is unaccounted for, or
    // the same finished build gets announced twice.
    if (pending.length === 0 || busy || awaitingTurn) return;

    // Marked rather than counted: `fetch_background_output` can drop a notice
    // from the middle of this list, so "the first n" would be wrong.
    for (const notice of pending) notice.sent = true;
    awaitingTurn = true;
    pi.sendMessage(
      {
        customType: "abacusai-bot-background-finished",
        content: pending.map((notice) => notice.text).join("\n\n"),
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true }
    );
  };

  pi.on("turn_start", async () => {
    busy = true;

    // A turn started, so the handover was taken. Only sent notices are
    // dropped; one that landed in between still waits.
    if (awaitingTurn) {
      for (let index = pending.length - 1; index >= 0; index--) {
        if (pending[index]?.sent === true) pending.splice(index, 1);
      }

      awaitingTurn = false;
    }
  });

  pi.on("agent_settled", async () => {
    busy = false;
    flush();
  });

  // A Stop empties the queue: the handover is gone, the notices are not, so
  // everything counts as unsent and goes again.
  const stopWatching = onConversationQueueCleared(() => {
    for (const notice of pending) notice.sent = false;

    awaitingTurn = false;
  });

  // Recovery after a Stop: the user typing is the first safe moment.
  pi.on("input", async () => {
    flush();
  });

  const unsubscribe = onBackgroundJobSettled((job) => {
    // Only jobs whose caller asked to be told, and not ones the agent killed
    // on purpose: waking a turn to say so is noise the user pays for.
    if (!job.notifyOnExit) return;
    if (job.exit?.killed === true) return;

    const seconds = Math.max(
      1,
      Math.round((Date.now() - job.startedAt) / 1_000)
    );
    const code = job.exit?.code;
    const outcome = code === 0 ? "finished" : `failed (exit ${String(code)})`;
    const output = tail(job.output);

    pending.push({
      id: job.id,
      sent: false,
      text: [
        `Background command ${job.id} ${outcome} after ${seconds}s: ${job.command}`,
        "",
        output.length > 0 ? output : "(no output)",
        "",
        "You started this and carried on. Pick it up now: if it was what you were waiting for,",
        "continue the work it was for; if it failed, deal with the failure. Do not re-run it just",
        "to see the output again — this is the output.",
      ].join("\n"),
    });

    flush();
  });

  // Nothing this process started should outlive it: a stray server keeps its
  // port bound with nobody left to stop it.
  pi.on("session_shutdown", async () => {
    unsubscribe();
    stopWatching();
    killAllBackgroundJobs();
  });

  const text = (body: string, isError = false) => ({
    content: [{ type: "text" as const, text: body }],
    details: {},
    ...(isError ? { isError: true } : {}),
  });

  pi.registerTool({
    name: "fetch_background_output",
    label: "Fetch Background Output",
    description:
      "Read what a background process has printed — anything started with a bash call made with " +
      "background: true. Works while it is still running and after it has finished, so it answers " +
      'both "how far has it got" and "what did it say".\n\n' +
      "Pass an id, or leave it off to see everything that is running and what became of it.\n\n" +
      "You do not need this to find out that a backgrounded command finished — you are told, with " +
      "its output. Reach for it when you want to look before then, or to read something again.",
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({
          description: 'The id to read, e.g. "bg-1". Omit to list everything.',
        })
      ),
    }),
    async execute(_toolCallId, params) {
      if (params.id == null) {
        const jobs = listBackgroundJobs();

        return text(
          jobs.length === 0
            ? "Nothing has been started in the background."
            : [
                ...jobs.map(describe),
                "",
                'Read one with fetch_background_output id:"bg-1".',
              ].join("\n")
        );
      }

      const job = getBackgroundJob(params.id);
      if (job == null)
        return text(`No background process with id ${params.id}.`, true);

      // Reading it yourself is being told; drop the pending notice.
      const waiting = pending.findIndex((notice) => notice.id === job.id);
      if (waiting !== -1) pending.splice(waiting, 1);

      const seconds = Math.max(
        1,
        Math.round((Date.now() - job.startedAt) / 1_000)
      );
      const output = job.output.trim();

      return text(
        [
          `${describe(job)}  (started ${seconds}s ago)`,
          "",
          output.length > 0
            ? output
            : job.exit == null
              ? "(nothing printed yet)"
              : "(it printed nothing)",
        ].join("\n")
      );
    },
  });

  pi.registerTool({
    name: "kill_process",
    label: "Kill Process",
    description:
      "Stop something started in the background with a bash call made with background: true. " +
      "Kills the whole process tree, so a wrapper script does not leave the real process " +
      "behind.\n\n" +
      "Pass an id to stop one, or leave it off to stop everything. Stopping a job you started " +
      "means you will not be told when it would have finished, because it will not.",
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({
          description: 'The id to stop, e.g. "bg-1". Omit to stop everything.',
        })
      ),
    }),
    async execute(_toolCallId, params) {
      if (params.id == null) {
        const stopped = killAllBackgroundJobs();

        return text(
          stopped.length === 0
            ? "Nothing was running in the background."
            : `Stopped ${stopped.length === 1 ? "1 process" : `${stopped.length} processes`}: ${stopped.join(", ")}.`
        );
      }

      const job = getBackgroundJob(params.id);
      if (job == null)
        return text(`No background process with id ${params.id}.`, true);

      if (!killBackgroundJob(params.id)) {
        return text(`${params.id} had already finished — nothing to stop.`);
      }

      return text(`Stopped ${params.id}: ${job.command}`);
    },
  });
}
