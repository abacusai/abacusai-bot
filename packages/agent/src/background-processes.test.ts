import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
/**
 * The promise this makes is about processes, so these start real ones.
 *
 * A mocked `spawn` would report every one of these cases as working: a job
 * that was never killed looks exactly like a job that was, right up until the
 * port is still bound half an hour after the app closed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getBackgroundJob,
  killAllBackgroundJobs,
  killAllForegroundProcesses,
  killBackgroundJob,
  listBackgroundJobs,
  notifyConversationQueueCleared,
  onBackgroundJobSettled,
  onConversationQueueCleared,
  registerForegroundProcess,
  removeBackgroundJob,
  resetBackgroundJobs,
  startBackgroundJob,
  type BackgroundJob,
} from "./background-processes.js";

const operations = createLocalBashOperations();

const start = (command: string, notifyOnExit = true): BackgroundJob =>
  startBackgroundJob({ command, cwd: process.cwd(), operations, notifyOnExit });

/** Wait for a job to settle, rather than sleeping and hoping. */
const settled = (id: string): Promise<BackgroundJob> =>
  new Promise((resolve) => {
    const stop = onBackgroundJobSettled((job) => {
      if (job.id !== id) return;
      stop();
      resolve(job);
    });
  });

/**
 * Stop everything this test started, and wait for the shells to actually be
 * gone before the next one starts.
 *
 * Killing was the easy half. On Windows the tree kill is a fire-and-forget
 * `taskkill /F /T` (it returns long before the tree is down), so a test that
 * left `sleep 30` running handed the next test a shell still being force-killed
 * underneath it. Git Bash forked in that window does not run the script: it
 * dies with STATUS_ACCESS_VIOLATION, and the job reports exit 3221225477 where
 * the test asked for 3. That is the intermittent Windows CI failure on this
 * file, and it is an artefact of the teardown rather than anything the code
 * under test did.
 *
 * The timeout is a backstop, not the mechanism: a kill that never settles
 * should fail the test that relied on it, not hang the whole suite here.
 */
const stopEverything = async (): Promise<void> => {
  const running = listBackgroundJobs().filter((job) => job.exit == null);
  const gone = running.map(
    (job) =>
      new Promise<void>((resolve) => {
        const stop = onBackgroundJobSettled((settledJob) => {
          if (settledJob.id !== job.id) return;
          stop();
          resolve();
        });
        // It may have finished on its own between the filter above and this
        // listener, and nothing would call the listener then.
        if (getBackgroundJob(job.id)?.exit != null) {
          stop();
          resolve();
        }
      })
  );

  killAllBackgroundJobs();
  await Promise.race([
    Promise.all(gone),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  resetBackgroundJobs();
};

afterEach(async () => {
  await stopEverything();
  killAllForegroundProcesses({ spawnCleanup: false });
});

describe("starting something and not waiting for it", () => {
  it("returns before the command has finished", async () => {
    const job = start("sleep 30");

    // The whole point: the caller is already past this while it runs.
    expect(job.exit).toBeNull();
    expect(listBackgroundJobs().map((entry) => entry.id)).toEqual([job.id]);
  });

  it("reports the exit code once it does finish", async () => {
    const job = start("echo done; exit 3");
    const finished = await settled(job.id);

    expect(finished.exit).toEqual({ code: 3, killed: false });
    expect(finished.output).toContain("done");
  });

  it("keeps the output readable afterwards", async () => {
    const job = start("echo kept");
    await settled(job.id);

    expect(getBackgroundJob(job.id)?.output).toContain("kept");
  });
});

describe("stopping one", () => {
  it("kills a running job and says it was killed", async () => {
    const job = start("sleep 30");

    expect(killBackgroundJob(job.id)).toBe(true);

    const finished = await settled(job.id);

    // Killed, not "exited 0": the difference decides whether the agent is told.
    expect(finished.exit?.killed).toBe(true);
  });

  // Skipped on Windows because the tree kill is not implemented there: the
  // backend's terminate() only kills the process group on POSIX and falls back
  // to killing the shell alone, so a stopped job still leaks its descendants.
  const posixOnly = it.skipIf(process.platform === "win32");

  posixOnly("takes the whole process tree, not just the shell", async () => {
    // The failure this exists to catch: killing `bash -c` leaves the `sleep`
    // it started running, holding whatever it held.
    const marker = `bg-tree-${process.pid}-${Date.now()}`;
    const job = start(`sleep 45 # ${marker}`);

    await new Promise((resolve) => setTimeout(resolve, 300));
    killBackgroundJob(job.id);
    await settled(job.id);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const survivors = await new Promise<string>((resolve) => {
      const ops = createLocalBashOperations();
      let out = "";
      void ops
        .exec(
          `ps -eo args | grep ${marker} | grep -v grep | grep -v ps || true`,
          process.cwd(),
          {
            onData: (data: Buffer) => {
              out += data.toString();
            },
          }
        )
        .then(() => resolve(out));
    });

    expect(survivors.trim()).toBe("");
  });

  it("reports nothing to stop for a job that already finished", async () => {
    const job = start("true");
    await settled(job.id);

    expect(killBackgroundJob(job.id)).toBe(false);
  });

  it("stops everything at once and names what it stopped", async () => {
    const first = start("sleep 30");
    const second = start("sleep 30");

    expect(killAllBackgroundJobs().sort()).toEqual(
      [first.id, second.id].sort()
    );
  });
});

describe("what the agent is told", () => {
  it("carries the flag the caller started it with", async () => {
    // A dev server is started so that nothing waits on it; a build is started
    // precisely so the agent can be interrupted when it lands.
    const server = start("sleep 30", false);
    const build = start("true", true);

    expect(getBackgroundJob(server.id)?.notifyOnExit).toBe(false);
    expect((await settled(build.id)).notifyOnExit).toBe(true);
  });

  it("tells every listener even when one of them throws", async () => {
    // One bad listener must not swallow the news for the rest, or the agent
    // silently never hears that its build finished.
    const seen: string[] = [];
    const stopFirst = onBackgroundJobSettled(() => {
      throw new Error("listener blew up");
    });
    const stopSecond = onBackgroundJobSettled((job) => {
      seen.push(job.id);
    });

    const job = start("true");
    await settled(job.id);
    stopFirst();
    stopSecond();

    expect(seen).toContain(job.id);
  });
});

describe("a command that cannot run at all", () => {
  it("keeps the reason instead of a bare failure", async () => {
    // A directory that is not there is the common one, and "exit null" on its
    // own tells the agent nothing it can act on.
    const job = startBackgroundJob({
      command: "echo nope",
      cwd: "/definitely/not/a/directory/here",
      operations,
      notifyOnExit: true,
    });
    const finished = await settled(job.id);

    expect(finished.exit?.killed).toBe(false);
    expect(finished.output).toMatch(/directory/i);
  });

  it("stops a job early when it was given a deadline", async () => {
    // Backgrounding removes the automatic deadline; it does not refuse one
    // that was asked for.
    const job = startBackgroundJob({
      command: "sleep 30",
      cwd: process.cwd(),
      operations,
      timeout: 1,
      notifyOnExit: true,
    });
    const started = Date.now();
    const finished = await settled(job.id);

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(finished.exit).not.toBeNull();
  });
});

describe("ids that are not there", () => {
  it("reads as nothing", () => {
    expect(getBackgroundJob("bg-nope")).toBeUndefined();
  });

  it("cannot be forgotten twice", () => {
    const job = start("sleep 30");

    expect(removeBackgroundJob(job.id)).toBe(true);
    expect(removeBackgroundJob(job.id)).toBe(false);
    expect(listBackgroundJobs()).toEqual([]);
  });
});

describe("telling the holder its queue was emptied", () => {
  it("reaches every listener, and stops when unsubscribed", () => {
    const seen: string[] = [];
    const stopFirst = onConversationQueueCleared(() => seen.push("first"));
    const stopSecond = onConversationQueueCleared(() => seen.push("second"));

    notifyConversationQueueCleared();
    stopFirst();
    notifyConversationQueueCleared();
    stopSecond();

    expect(seen).toEqual(["first", "second", "second"]);
  });

  it("is not silenced by a listener that throws", () => {
    // Losing this signal means a finished job's news is never said again.
    const seen: string[] = [];
    const stopFirst = onConversationQueueCleared(() => {
      throw new Error("listener blew up");
    });
    const stopSecond = onConversationQueueCleared(() =>
      seen.push("still told")
    );

    notifyConversationQueueCleared();
    stopFirst();
    stopSecond();

    expect(seen).toEqual(["still told"]);
  });
});

/**
 * The cleanup that has to run when the process is going away.
 *
 * These fire the handlers directly rather than signalling for real, because a
 * test that actually terminates its own runner reports nothing. `process.kill`
 * is stubbed for the same reason: the handler re-raises the signal to restore
 * Node's default, and that default is to die.
 */
describe("going away", () => {
  it("kills what is running when the process exits", () => {
    const job = start("sleep 30");

    process.emit("exit", 0);

    expect(getBackgroundJob(job.id)?.exit?.killed).toBe(true);
  });

  it("kills what is running on SIGTERM, then lets the signal do its job", () => {
    // SIGTERM is what the desktop sends when it stops a session, so this is
    // the quit path, and the one that would strand a server holding a port.
    const job = start("sleep 2");
    const raised: Array<string | number | undefined> = [];
    const kill = vi.spyOn(process, "kill").mockImplementation(((
      _pid: number,
      signal?: string | number
    ) => {
      raised.push(signal);

      return true;
    }) as never);
    // The test runner has its own handler on this signal, which is exactly the
    // bystander that used to be swept away with ours.
    const before = process.listeners("SIGTERM");

    try {
      process.emit("SIGTERM");

      const after = process.listeners("SIGTERM");

      expect(getBackgroundJob(job.id)?.exit?.killed).toBe(true);
      // Re-raised rather than exiting with a code of our own invention.
      expect(raised).toContain("SIGTERM");
      // Exactly one handler stood down: ours.
      expect(after).toHaveLength(before.length - 1);
      expect(
        before.filter((listener) => !after.includes(listener))
      ).toHaveLength(1);
    } finally {
      kill.mockRestore();
    }
  });
});

/**
 * Foreground children are the other half of the same promise: a tool call's
 * in-flight command must not survive the agent that started it either.
 */
describe("foreground children on the way out", () => {
  it("kills registered children when the process exits, without spawning", () => {
    const kill = vi.fn();
    const spawnCleanup = vi.fn();

    registerForegroundProcess({ kill, spawnCleanup });
    process.emit("exit", 0);

    expect(kill).toHaveBeenCalledOnce();
    // The event loop is gone inside 'exit'; a spawn there can never run.
    expect(spawnCleanup).not.toHaveBeenCalled();
  });

  it("runs the spawning cleanup too on the signal path", () => {
    // Called directly rather than via process.emit: the module's SIGTERM
    // handler stands down after its first firing (it re-raises, and the
    // re-raise normally ends the process), and the test above already fired it.
    const kill = vi.fn();
    const spawnCleanup = vi.fn();

    registerForegroundProcess({ kill, spawnCleanup });
    killAllForegroundProcesses({ spawnCleanup: true });

    expect(kill).toHaveBeenCalledOnce();
    expect(spawnCleanup).toHaveBeenCalledOnce();
  });

  it("stops tracking a child once deregistered", () => {
    const kill = vi.fn();
    const unregister = registerForegroundProcess({ kill });

    unregister();
    process.emit("exit", 0);

    expect(kill).not.toHaveBeenCalled();
  });

  it("keeps killing when one child's kill throws", () => {
    const kill = vi.fn();

    registerForegroundProcess({
      kill: () => {
        throw new Error("already reaped");
      },
    });
    registerForegroundProcess({ kill });
    killAllForegroundProcesses({ spawnCleanup: false });

    expect(kill).toHaveBeenCalledOnce();
  });
});

describe("a backend that fails in an unusual way", () => {
  it("records what was thrown even when it was not an Error", () => {
    // Backends are pluggable, so what comes back is not ours to assume.
    // Dropping it would leave the agent an exit code and no reason.
    const job = startBackgroundJob({
      command: "anything",
      cwd: process.cwd(),
      notifyOnExit: true,
      operations: { exec: () => Promise.reject("a bare string, not an Error") },
    });

    return settled(job.id).then((finished) => {
      expect(finished.output).toContain("a bare string, not an Error");
      expect(finished.exit).toEqual({ code: null, killed: false });
    });
  });
});
