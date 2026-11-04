/**
 * The scheduler half of cron: a minute tick that fires due jobs. What a run
 * actually does (spawn a session, send the prompt) is injected by the host.
 * Each scheduled moment fires at most once: it is claimed on disk before its
 * run starts. A fire due while the network is down waits for it; one missed
 * while the computer was off is made up once, for the latest moment only, and
 * so is one whose run the app closed under (a quit, a crash, an update). A
 * write the store refuses (Windows can hold `cronjobs.json` for a moment) costs
 * that one job its turn: the rest fire, and the next tick looks again.
 */
import {
  catchUpWorthIt,
  claimSlot,
  dueJobs,
  getJob,
  heldJobs,
  minuteOf,
  missedJobs,
  recordRun,
  retireOnceJob,
  setHeld,
  setMissed,
  slotFor,
  type CronJob,
} from "./cron-store";
import { mintAttemptId, ROUTINE_RESULTS } from "./routine-attempts";

/** The scheduled moment a fire stands for, and the attempt that claimed it. */
export interface SlotFire {
  slot: number;
  attemptId: string;
}

/** How a scheduler fire started: on time, or making up a missed or cut-off run. */
type SlotTrigger = "schedule" | "catch-up" | "interrupted";

type RunJob = (
  jobId: string,
  trigger: SlotTrigger,
  fire: SlotFire
) => Promise<void>;

/** Whether a run may start now; probes when its answer is stale. */
type NetworkReady = () => Promise<boolean>;

/** A gap between ticks longer than this is a sleep (or a stall), not drift. */
const MISSED_TICK_GAP_MS = 2 * 60_000;

/** Between two held fires let go together, so a launch does not start them all at once. */
const RELEASE_SPACING_MS = 30_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

export class CronScheduler {
  /** Housekeeping the host wants once a minute, before the due jobs fire. */
  private onMinute: (() => void) | null = null;

  private cronTimer: NodeJS.Timeout | null = null;
  /** Last minute fired, so two ticks in one minute cannot double-fire. */
  private lastCronMinute = "";
  private lastTickAt: number | null = null;
  /** A write was refused: the next tick reads what is unfired off the disk. */
  private storeRefused = false;
  private releasing: Promise<void> | null = null;

  constructor(
    private readonly runJob: RunJob,
    private readonly networkReady: NetworkReady = async () => true,
    /** Told whenever the held set changes, for the routine list. */
    private readonly onHeldChange: () => void = () => {},
    private readonly wait: (ms: number) => Promise<void> = sleep
  ) {}

  everyMinute(callback: () => void): void {
    this.onMinute = callback;
  }

  /** Whether this job is held until the network is back (not a make-up waiting its tick). */
  isHeld(jobId: string): boolean {
    const job = getJob(jobId);
    return job?.heldSince != null && (job.heldFor ?? "network") === "network";
  }

  /**
   * Ticks every 20 seconds, not 60: a minute interval drifts and a late tick
   * would skip that minute's jobs. Firing is keyed on the minute string.
   */
  start(): void {
    if (this.cronTimer != null) return;

    this.cronTimer = setInterval(() => {
      this.tick().catch((err: unknown) => {
        console.error("[cron] tick failed:", err);
      });
    }, 20_000);

    this.cronTimer.unref?.();
  }

  stop(): void {
    if (this.cronTimer == null) return;

    clearInterval(this.cronTimer);
    this.cronTimer = null;
  }

  /**
   * The network is back (or the machine woke): run what was held, once each,
   * spaced apart. A hold whose moment has gone stale is let go unrun.
   */
  async release(): Promise<void> {
    if (heldJobs().length === 0) return;
    if (this.releasing != null) return this.releasing;
    this.releasing = (async () => {
      if (!(await this.networkReady())) return;
      let fired = 0;
      for (const job of heldJobs()) {
        // Let go one at a time: a quit midway keeps the rest held, and one
        // the store would not let go stays held for the next tick.
        if (!this.stored(() => setHeld(job.id, null))) continue;
        this.onHeldChange();
        if (!job.enabled) continue;
        const slot = job.runAt ?? job.heldSlot ?? minuteOf(job.heldSince!);
        const trigger: SlotTrigger =
          job.heldFor === "catch-up" || job.heldFor === "interrupted"
            ? job.heldFor
            : "schedule";
        if (
          job.schedule != null &&
          !catchUpWorthIt(job.schedule, slot, Date.now())
        ) {
          if (trigger === "schedule")
            this.stored(() =>
              recordRun(job.id, ROUTINE_RESULTS.skippedOffline, "schedule", {
                kind: "skipped-offline",
              })
            );
          continue;
        }
        if (fired++ > 0) await this.wait(RELEASE_SPACING_MS);
        await this.fire(job, slot, trigger);
      }
    })();
    try {
      await this.releasing;
    } finally {
      this.releasing = null;
    }
  }

  async tick(now: Date = new Date()): Promise<void> {
    const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

    if (minute === this.lastCronMinute) return;

    this.lastCronMinute = minute;
    const lastTickAt = this.lastTickAt;
    this.lastTickAt = now.getTime();
    const lookAgain = this.storeRefused;
    this.storeRefused = false;

    try {
      this.onMinute?.();
    } catch (err) {
      console.error("[cron] minute maintenance failed:", err);
    }

    const due = dueJobs(now);
    // Fires slept through, or missed while the app was closed (the first
    // tick), are counted; the latest is made up once, if still worth it.
    const missed =
      lastTickAt == null ||
      lookAgain ||
      now.getTime() - lastTickAt > MISSED_TICK_GAP_MS
        ? missedJobs(
            lastTickAt == null || lookAgain ? null : new Date(lastTickAt),
            now
          )
        : [];
    const dueIds = new Set(due.map((job) => job.id));
    const missedIds = new Set(missed.map(({ job }) => job.id));
    for (const { job, count, latest } of missed) {
      this.stored(() => setMissed(job.id, { count, at: now.getTime() }));
      // A later moment missed is the run to make up, over an interrupted one.
      if (
        !dueIds.has(job.id) &&
        (job.heldSince == null || job.heldFor === "interrupted") &&
        job.schedule != null &&
        catchUpWorthIt(job.schedule, latest, now.getTime())
      )
        this.stored(() =>
          setHeld(job.id, now.getTime(), { slot: latest, reason: "catch-up" })
        );
    }

    if (
      (due.length > 0 || heldJobs().length > 0) &&
      !(await this.networkReady())
    ) {
      for (const job of due) {
        // Its next fire came with the network still down: the held one is
        // skipped, said so, and this one waits in its place.
        if (job.heldSince != null && job.runAt == null)
          this.stored(() =>
            recordRun(job.id, ROUTINE_RESULTS.skippedOffline, "schedule", {
              kind: "skipped-offline",
            })
          );
        if (job.heldSince == null || job.runAt == null)
          this.stored(() =>
            setHeld(job.id, now.getTime(), {
              slot: slotFor(job, now),
              reason: "network",
            })
          );
      }
      this.onHeldChange();
      return;
    }

    for (const job of due) {
      // A due fire is the same run a held one would have been.
      if (job.heldSince != null) this.stored(() => setHeld(job.id, null));
      // Back on time: what it missed before is history.
      if (job.missed != null && !missedIds.has(job.id))
        this.stored(() => setMissed(job.id, null));
      await this.fire(job, slotFor(job, now), "schedule");
    }
    if (missed.length > 0) this.onHeldChange();
    await this.release();
  }

  /** A store write that may be refused; whether it landed. */
  private stored(write: () => void): boolean {
    try {
      write();
      return true;
    } catch (err) {
      console.error("[cron] could not save a routine's state:", err);
      this.storeRefused = true;
      return false;
    }
  }

  private async fire(
    job: CronJob,
    slot: number,
    trigger: SlotTrigger
  ): Promise<void> {
    const attemptId = mintAttemptId();
    // Claimed before the run: a restart, a second tick or a run longer than
    // a tick finds the moment taken and never fires it again. A make-up of a
    // cut-off run takes over that run's claim.
    try {
      if (!claimSlot(job.id, slot, attemptId, trigger === "interrupted"))
        return;
    } catch (err) {
      // Unclaimed: a one-time job is still due, a cron moment the next tick finds.
      console.error("[cron] could not claim a routine's fire:", err);
      this.storeRefused = true;
      return;
    }
    if (job.runAt != null) {
      try {
        retireOnceJob(job.id);
      } catch (err) {
        // The claim already keeps it from firing again.
        console.error("[cron] could not retire a one-off job:", err);
      }
    }
    try {
      await this.runJob(job.id, trigger, { slot, attemptId });
    } catch (err) {
      // One failing job must not stop the others from firing.
      this.stored(() =>
        recordRun(
          job.id,
          `${ROUTINE_RESULTS.fireFailedPrefix}${err instanceof Error ? err.message : String(err)}`,
          trigger,
          { kind: "start-failed", id: attemptId }
        )
      );
    }
  }
}
