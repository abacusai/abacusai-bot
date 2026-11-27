import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
/**
 * Shell commands that outlive the tool call, and the telling when they land.
 * The agent should not have to poll, so a job that lands while a turn is
 * running goes into that turn. One that lands with no turn running starts
 * nothing: a run nobody asked for bills them, and pi runs it outside any open
 * chat run, so nothing it does reaches the chat. The person is told directly
 * and the output waits in the conversation for their next message. This
 * extension holds pi's `sendMessage`, which the tool cannot reach.
 */
import { Type } from "typebox";

import {
  getBackgroundJob,
  killAllBackgroundJobs,
  killBackgroundJob,
  listBackgroundJobs,
  onBackgroundJobSettled,
  onBackgroundOutput,
  onConversationQueueCleared,
  onUserMessageWaiting,
  reportBackgroundJob,
  type BackgroundJob,
  type BackgroundReport,
} from "../background-processes.js";

/** Trimmed before it goes into the conversation: the tail is where the verdict is. */
const NOTIFY_OUTPUT_BYTES = 4_000;

/** The longest one wait may ask for: inside the tool's call budget (tool-timeouts). */
export const MAX_WAIT_SECONDS = 120;
/** How often the user's view of the output is redrawn while a wait runs. */
const WAIT_UPDATE_MS = 1_000;

/** Why a wait ended. */
type WaitEnd = "finished" | "matched" | "user" | "stopped" | "time";

/**
 * Waits on background jobs until one of them finishes, `until` appears in
 * their new output, the user writes, the call is stopped, or `ms` pass. Each
 * redraw hands the jobs' output to `show`, which the user watches.
 */
const waitOn = (
  ids: readonly string[],
  ms: number,
  until: string | null,
  signal: AbortSignal | undefined,
  show: () => void
): Promise<WaitEnd> =>
  new Promise((resolve) => {
    const from = new Map(
      ids.map((id) => [id, getBackgroundJob(id)?.output.length ?? 0])
    );
    const needle = until?.toLowerCase() ?? null;
    let redraw: NodeJS.Timeout | null = null;
    const cleanups: Array<() => void> = [];
    const end = (why: WaitEnd): void => {
      for (const cleanup of cleanups.splice(0)) cleanup();
      if (redraw != null) clearTimeout(redraw);
      show();
      resolve(why);
    };
    cleanups.push(
      onBackgroundJobSettled((job) => {
        if (ids.includes(job.id)) end("finished");
      }),
      onBackgroundOutput(() => {
        if (
          needle != null &&
          ids.some((id) =>
            (getBackgroundJob(id)?.output ?? "")
              .slice(from.get(id) ?? 0)
              .toLowerCase()
              .includes(needle)
          )
        ) {
          end("matched");
          return;
        }
        redraw ??= setTimeout(() => {
          redraw = null;
          show();
        }, WAIT_UPDATE_MS);
      }),
      onUserMessageWaiting(() => end("user"))
    );
    const timer = setTimeout(() => end("time"), ms);
    cleanups.push(() => clearTimeout(timer));
    if (signal != null) {
      const stop = (): void => end("stopped");
      if (signal.aborted) {
        stop();
        return;
      }
      signal.addEventListener("abort", stop, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", stop));
    }
  });

/** What the model is told about a wait that ended with the job(s) still running. */
const STILL_RUNNING: Record<Exclude<WaitEnd, "finished">, string> = {
  matched: "The text you waited for appeared; it is still running.",
  user:
    "The user wrote while you waited: answer them now. It is still running; wait again " +
    "afterwards if the work still needs it.",
  stopped: "The wait was stopped; it is still running.",
  time:
    "Still running when the wait ran out. Tell the user in one line where it stands, then wait " +
    "again if the next step needs it, or carry on with something that does not.",
};

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
   * the user pressed Stop would never be mentioned. A notice handed to a
   * running turn leaves only once the next step starting proves it was taken.
   */
  const pending: Array<{
    id: string;
    text: string;
    sent: boolean;
    report: BackgroundReport;
  }> = [];
  let busy = false;
  /** Jobs a fetch_background_output call is waiting on: its answer carries their end. */
  const waitedOn = new Set<string>();

  /** Nothing running will mention these, so the person hears from the app. */
  const tellThePerson = (): void => {
    for (const notice of pending.splice(0)) reportBackgroundJob(notice.report);
  };

  /** Hands over what has not gone yet: into the running turn, or onto the record. */
  const flush = (): void => {
    // Marked rather than counted: `fetch_background_output` can drop a notice
    // from the middle of this list, so "the first n" would be wrong.
    const unsent = pending.filter((notice) => !notice.sent);
    if (unsent.length === 0) return;

    for (const notice of unsent) notice.sent = true;
    const message = {
      customType: "abacusai-bot-background-finished",
      content: unsent.map((notice) => notice.text).join("\n\n"),
      display: true,
    };

    if (busy) {
      pi.sendMessage(message, { deliverAs: "steer" });
      return;
    }

    // No turn to take it: written into the conversation, so the next prompt
    // carries it and it outlives this process, and no model is called.
    pi.sendMessage(message);
    tellThePerson();
  };

  pi.on("turn_start", async () => {
    busy = true;

    // pi polls its queue just before a step starts, so what was sent is taken.
    // One that landed in between still waits.
    for (let index = pending.length - 1; index >= 0; index--) {
      if (pending[index]?.sent === true) pending.splice(index, 1);
    }
  });

  pi.on("agent_settled", async () => {
    busy = false;
    flush();
    // Steered after pi last looked: its next run takes it, but this one's
    // reply was written without it.
    tellThePerson();
  });

  // A Stop empties the queue: the handover is gone, the notices are not.
  const stopWatching = onConversationQueueCleared(() => {
    for (const notice of pending) notice.sent = false;
  });

  // A notice a Stop handed back after the turn had already settled.
  pi.on("input", async () => {
    flush();
  });

  const unsubscribe = onBackgroundJobSettled((job) => {
    // Only jobs whose caller asked to be told, and not ones the agent killed
    // on purpose: it knows, it asked.
    if (!job.notifyOnExit) return;
    if (job.exit?.killed === true) return;
    // A wait on it answers with its end; a notice would only say it again.
    if (waitedOn.has(job.id)) return;

    const seconds = Math.max(
      1,
      Math.round((Date.now() - job.startedAt) / 1_000)
    );
    const code = job.exit?.code;
    const timedOut = job.exit?.timedOut === true;
    const outcome = timedOut
      ? "was stopped by the timeout you gave it"
      : code === 0
        ? "finished"
        : `failed (exit ${String(code)})`;
    const output = tail(job.output);

    pending.push({
      id: job.id,
      sent: false,
      report: {
        id: job.id,
        command: job.command,
        outcome: timedOut ? "timed-out" : code === 0 ? "finished" : "failed",
      },
      text: [
        `Background command ${job.id} ${outcome} after ${seconds}s: ${job.command}`,
        "",
        output.length > 0 ? output : "(no output)",
        "",
        "You started this and carried on. If the work you are doing needs it, use it; if it failed",
        "and that matters to what was asked, deal with that. It is not a request: do not start",
        "anything new because of it. Do not re-run it just to see the output: this is the output.",
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
      "Read what a background process has printed: anything started with a bash call made with " +
      "background: true. Works while it is still running and after it has finished, so it answers " +
      'both "how far has it got" and "what did it say".\n\n' +
      "Pass an id, or leave it off to see everything that is running and what became of it.\n\n" +
      "To wait for a background job, pass wait_seconds: the call returns as soon as the job " +
      "finishes (or as soon as the text you pass as until appears in its output), and the user " +
      "watches its output meanwhile. It also returns early when the user writes, so you can " +
      "answer them. Never wait with sleep: a sleep shows the user nothing and holds their " +
      "messages until it ends.\n\n" +
      "You do not need this to find out that a backgrounded command finished while you are " +
      "working: you are told, with its output. Reach for it to wait for one, to look before " +
      "then, or to read something again.",
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({
          description:
            'The id to read, e.g. "bg-1". Omit to list everything, or with wait_seconds to wait ' +
            "on every job still running.",
        })
      ),
      wait_seconds: Type.Optional(
        Type.Number({
          description: `Wait up to this many seconds (at most ${MAX_WAIT_SECONDS}) for it to finish before answering.`,
        })
      ),
      until: Type.Optional(
        Type.String({
          description:
            'With wait_seconds: stop waiting once this text appears in its output (e.g. "Listening on").',
        })
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const waitSeconds = Math.min(
        MAX_WAIT_SECONDS,
        Math.max(0, Math.round(params.wait_seconds ?? 0))
      );
      const waitFor = (
        params.id != null
          ? [getBackgroundJob(params.id)].filter((job) => job != null)
          : listBackgroundJobs()
      ).filter((job) => job.exit == null);
      if (waitSeconds > 0 && waitFor.length > 0) {
        const ids = waitFor.map((job) => job.id);
        for (const id of ids) waitedOn.add(id);
        const startedWaiting = Date.now();
        const output = (): string =>
          ids
            .map((id) => {
              const job = getBackgroundJob(id);
              return job == null
                ? ""
                : `${ids.length > 1 ? `${describe(job)}\n` : ""}${tail(job.output)}`;
            })
            .join("\n\n");
        let why: WaitEnd;
        try {
          why = await waitOn(
            ids,
            waitSeconds * 1_000,
            params.until?.trim() || null,
            signal,
            () =>
              onUpdate?.({
                content: [{ type: "text", text: output() }],
                details: {},
              })
          );
        } finally {
          for (const id of ids) waitedOn.delete(id);
        }
        const waited = Math.max(
          1,
          Math.round((Date.now() - startedWaiting) / 1_000)
        );
        const states = ids.map((id) => {
          const job = getBackgroundJob(id);
          return job == null ? id : describe(job);
        });
        return text(
          [
            `Waited ${waited}s. ${why === "finished" ? "It finished." : STILL_RUNNING[why]}`,
            ...states,
            "",
            output() || "(nothing printed yet)",
          ].join("\n")
        );
      }

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
        return text(`${params.id} had already finished; nothing to stop.`);
      }

      return text(`Stopped ${params.id}: ${job.command}`);
    },
  });
}
