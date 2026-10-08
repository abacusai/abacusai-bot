/**
 * Hosted routine results for the app's own notifications: while someone is
 * listening (the Routines panel's notifier is open), the server's `feed` is
 * read every few minutes and each run that finished since is announced once.
 * The panel's rows are re-read alongside, so its last results catch up.
 *
 * The feed is read even while the server has routines switched off (it still
 * answers then); an old server's refusal is no runs. Nothing old is
 * announced: the first read starts from when listening began. After more
 * than a day away, what came in meanwhile is told as one summary.
 */
import type { HostedRoutineRun } from "@abacus-ai/contract/routines";

import type { HostedRoutines } from "./hosted-routines";

/** Runs remembered as announced; far more than one poll ever returns. */
const SEEN_KEPT = 500;

/** The server's page size: a full page means more may wait. */
const FEED_PAGE_RUNS = 100;

/** The most pages one poll reads; the next poll picks up the rest. */
const FEED_MAX_PAGES = 20;

/** Away longer than this, what came in meanwhile is one summary. */
const AWAY_SUMMARY_MS = 24 * 60 * 60_000;

/** One finished run, or the runs that came in while the app was away. */
export type HostedFeedEvent =
  | { type: "run"; run: HostedRoutineRun }
  | { type: "away"; runs: HostedRoutineRun[] };

export class HostedRoutineFeed {
  private readonly listeners = new Set<(event: HostedFeedEvent) => void>();
  private timer: NodeJS.Timeout | null = null;
  /** The next read's `since`: the server's own clock from the last read. */
  private since = "";
  private readonly seen: string[] = [];
  private polling = false;
  /** The next poll's runs go out as one summary. */
  private away = false;

  constructor(
    private readonly options: {
      hosted: Pick<HostedRoutines, "feed" | "refresh">;
      /** How often to read the feed while someone listens. */
      intervalMs: () => number;
      now?: () => number;
      log?: (line: string) => void;
      /**
       * Where the last read's `since` is kept across restarts, so a result
       * that came in while the app was closed is announced, and none twice.
       */
      store?: { read: () => string | null; write: (since: string) => void };
    }
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private log(line: string): void {
    (this.options.log ?? console.warn)(line);
  }

  /** Hear each finished hosted run once; reading stops with the last listener. */
  listen(listener: (event: HostedFeedEvent) => void): () => void {
    this.listeners.add(listener);
    if (this.timer == null) this.begin();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.end();
    };
  }

  private begin(): void {
    // Where the last read left off; a first ever listen starts from now.
    const stored = this.options.store?.read() ?? null;
    this.since = stored ?? new Date(this.now()).toISOString();
    const storedAt = stored != null ? Date.parse(stored) : NaN;
    this.away =
      Number.isFinite(storedAt) && this.now() - storedAt > AWAY_SUMMARY_MS;
    this.timer = setInterval(() => void this.poll(), this.options.intervalMs());
    this.timer.unref?.();
    // The first read now; it re-reads the rows too, so the panel lists them.
    void this.poll().then((fresh) => {
      if (fresh.length === 0) void this.options.hosted.refresh();
    });
  }

  private end(): void {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Read the feed, page by page; exposed for tests. */
  async poll(): Promise<HostedRoutineRun[]> {
    if (this.polling) return [];
    this.polling = true;
    try {
      const fresh: HostedRoutineRun[] = [];
      for (let page = 0; page < FEED_MAX_PAGES; page++) {
        const { runs, now } = await this.options.hosted.feed(this.since);
        const added = runs.filter(
          (run) => run.id.length > 0 && !this.seen.includes(run.id)
        );
        for (const run of added) this.seen.push(run.id);
        fresh.push(...added);
        // A full page: read on from its last finish; repeats are deduped.
        const last = Math.max(...runs.map((run) => run.at ?? -Infinity));
        if (
          runs.length >= FEED_PAGE_RUNS &&
          added.length > 0 &&
          Number.isFinite(last)
        ) {
          this.keep(new Date(last).toISOString());
          continue;
        }
        if (now != null) this.keep(now);
        break;
      }
      this.seen.splice(0, Math.max(0, this.seen.length - SEEN_KEPT));
      const away = this.away;
      this.away = false;
      if (fresh.length > 0) {
        void this.options.hosted.refresh();
        if (away) this.announce({ type: "away", runs: fresh });
        else for (const run of fresh) this.announce({ type: "run", run });
      }
      return fresh;
    } catch (error) {
      this.log(
        `[routines] feed read failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    } finally {
      this.polling = false;
    }
  }

  /** The next read's `since`, kept across restarts. */
  private keep(since: string): void {
    this.since = since;
    try {
      this.options.store?.write(since);
    } catch {
      // Kept in memory; the next write tries again.
    }
  }

  private announce(event: HostedFeedEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.log(
          `[routines] feed listener threw: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
}
