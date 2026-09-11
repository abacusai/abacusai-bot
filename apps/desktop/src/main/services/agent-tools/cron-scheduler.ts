/**
 * The scheduler half of cron: a minute tick that fires due jobs. What a run
 * actually does (spawn a session, send the prompt) is injected by the host.
 */
import { dueJobs, recordRun, retireOnceJob } from "./cron-store";

type RunJob = (jobId: string, trigger: "schedule") => Promise<void>;

export class CronScheduler {
  /** Housekeeping the host wants once a minute, before the due jobs fire. */
  private onMinute: (() => void) | null = null;

  private cronTimer: NodeJS.Timeout | null = null;
  /** Last minute fired, so two ticks in one minute cannot double-fire. */
  private lastCronMinute = "";

  constructor(private readonly runJob: RunJob) {}

  everyMinute(callback: () => void): void {
    this.onMinute = callback;
  }

  /**
   * Ticks every 20 seconds, not 60: a minute interval drifts and a late tick
   * would skip that minute's jobs. Firing is keyed on the minute string.
   */
  start(): void {
    if (this.cronTimer != null) return;

    this.cronTimer = setInterval(() => {
      void this.tick();
    }, 20_000);

    this.cronTimer.unref?.();
  }

  stop(): void {
    if (this.cronTimer == null) return;

    clearInterval(this.cronTimer);
    this.cronTimer = null;
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const minute = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

    if (minute === this.lastCronMinute) return;

    this.lastCronMinute = minute;

    try {
      this.onMinute?.();
    } catch (err) {
      console.error("[cron] minute maintenance failed:", err);
    }

    for (const job of dueJobs(now)) {
      // Retire before the run: a run longer than a tick would fire twice.
      if (job.runAt != null) retireOnceJob(job.id);
      try {
        await this.runJob(job.id, "schedule");
      } catch (err) {
        // One failing job must not stop the others from firing.
        recordRun(
          job.id,
          `failed to start: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
}
