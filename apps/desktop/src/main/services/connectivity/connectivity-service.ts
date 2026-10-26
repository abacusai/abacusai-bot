/**
 * The one owner of "can this machine reach Abacus": the OS's own answer where
 * there is one (Electron's `net.isOnline`), sleep and wake, a light probe of
 * the Abacus API, and what every call to Abacus reports about how it went.
 * Agents, the routine scheduler, the background pollers and the app's notice
 * all read it from here.
 *
 * Failed calls share one backoff: each failure that started after the last
 * one was counted holds background calls for 10s, 20s, 40s, 80s, then 2 min.
 * While Abacus is not answering, the probe alone retries on that schedule,
 * so an outage costs one small request per step instead of every poller
 * failing on its own timer. Anything that answers, the OS finding a network,
 * a wake or a user action starts over at once. A user action is never held.
 */
import { lookup } from "node:dns/promises";

import type { AbacusReachability } from "@abacus-ai/contract/contract/system";

import { abacusRoutellmV1, abacusUserAgent } from "../providers/abacus-host";
import {
  type AbacusCallSink,
  installAbacusCallSink,
  isNetworkFailure,
} from "./abacus-calls";

/** `degraded`: the OS has a network, but the Abacus API does not answer. */
export type ConnectivityState = "online" | "offline" | "degraded";

export interface ConnectivityChange {
  state: ConnectivityState;
  /** The machine just woke: worth a retry even if the state did not move. */
  resumed: boolean;
}

export interface ConnectivityOptions {
  /** Whether the Abacus API answers at all. */
  probe?: () => Promise<boolean>;
  /** Whether the internet answers at all; asked only when Abacus did not. */
  internet?: () => Promise<boolean>;
  now?: () => number;
  log?: (line: string) => void;
}

/** How often the OS's own answer is read: a local call, no traffic. */
const OS_POLL_MS = 5_000;
/** How long background calls wait after each failed try, in order; the last repeats. */
const BACKOFF_MS = [10_000, 20_000, 40_000, 80_000, 120_000];
/** A fresh-enough answer for a caller about to start network work. */
const PROBE_FRESH_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;
/** The notice waits this long, or this many failed tries: a blip never shows. */
const NOTICE_AFTER_MS = 30_000;
const NOTICE_AFTER_FAILURES = 3;

const short = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 120);

const duration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
};

/** A name any working DNS resolves (reserved for examples by IANA). */
const NEUTRAL_HOST = "example.com";
const LOOKUP_TIMEOUT_MS = 3_000;

/**
 * Whether names resolve at all: no DNS answer with the OS still reporting
 * a network is the internet down, not Abacus. A lookup only, no request.
 */
export const internetAnswers = async (): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      lookup(NEUTRAL_HOST),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("timeout")),
          LOOKUP_TIMEOUT_MS
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/** Any HTTP answer counts: the question is the network, not the account. */
export const probeAbacus = async (): Promise<boolean> => {
  try {
    await fetch(`${abacusRoutellmV1()}/models`, {
      method: "HEAD",
      headers: { "user-agent": abacusUserAgent() },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
};

export class ConnectivityService implements AbacusCallSink {
  private current: ConnectivityState = "online";
  private readonly listeners = new Set<(change: ConnectivityChange) => void>();
  private readonly reachListeners = new Set<
    (reach: AbacusReachability) => void
  >();
  private osOnline: (() => boolean) | null = null;
  private osTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private probing: Promise<void> | null = null;
  private lastProbeAt = 0;
  private asleep = false;
  /** Failed tries in a row, each one step of the backoff. */
  private failures = 0;
  /** Background calls wait until then. */
  private holdUntil = 0;
  /** When the last failed try was counted; a call started before it is part of it. */
  private lastStepAt = Number.NEGATIVE_INFINITY;
  /** When the current run of failures began; null while all is well. */
  private troubleSince: number | null = null;
  /** The recovery since the last failed try was logged already. */
  private toldRecovery = true;
  private readonly waiters = new Set<() => void>();
  private published: AbacusReachability = { state: "ok", retryAt: null };
  private readonly probe: () => Promise<boolean>;
  private readonly internet: () => Promise<boolean>;
  /** The OS's last answer; only a change of it moves anything. */
  private osUp = true;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(options: ConnectivityOptions = {}) {
    this.probe = options.probe ?? probeAbacus;
    this.internet = options.internet ?? internetAnswers;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.warn(line));
  }

  get state(): ConnectivityState {
    return this.current;
  }

  get online(): boolean {
    return this.current === "online";
  }

  onChange(listener: (change: ConnectivityChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** What the app's notice shows; told again whenever it changes. */
  get reachability(): AbacusReachability {
    return this.published;
  }

  onReachability(listener: (reach: AbacusReachability) => void): () => void {
    this.reachListeners.add(listener);
    return () => {
      this.reachListeners.delete(listener);
    };
  }

  /**
   * The OS's answer, polled from now on. Absent on a server, where the host
   * is online unless its own probe says otherwise.
   */
  start(osOnline?: () => boolean): void {
    this.osOnline = osOnline ?? null;
    if (this.osOnline == null || this.osTimer != null) return;
    this.readOs();
    this.osTimer = setInterval(() => this.readOs(), OS_POLL_MS);
    this.osTimer.unref?.();
  }

  stop(): void {
    if (this.osTimer != null) clearInterval(this.osTimer);
    this.osTimer = null;
    this.clearTimer("retryTimer");
    this.clearTimer("holdTimer");
    this.clearTimer("noticeTimer");
  }

  suspended(): void {
    this.asleep = true;
  }

  /** The machine woke: the network it had may be gone, or back. */
  resumed(): void {
    this.asleep = false;
    this.resetBackoff();
    void this.check({ resumed: true });
  }

  /** A request somewhere failed at the network level: worth a look. */
  reportFailure(): void {
    if (this.probing != null || this.now() - this.lastProbeAt < OS_POLL_MS)
      return;
    void this.check();
  }

  /** Probe now unless an answer is fresh; for a caller about to need the network. */
  async ensureFresh(): Promise<ConnectivityState> {
    if (this.current === "offline") return this.current;
    if (this.now() - this.lastProbeAt >= PROBE_FRESH_MS) await this.check();
    return this.current;
  }

  /** Whether a background call may go out now. */
  get backgroundReady(): boolean {
    return this.current === "online" && this.now() >= this.holdUntil;
  }

  /** Resolves once a background call may go out, or when `signal` aborts. */
  untilBackgroundReady(signal?: AbortSignal): Promise<void> {
    if (this.backgroundReady || signal?.aborted === true)
      return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        this.waiters.delete(wake);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const wake = (): void => {
        if (this.backgroundReady) done();
      };
      this.waiters.add(wake);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /**
   * Someone asked for something (Try now, a message, Connect): the backoff
   * starts over and, if anything is wrong, Abacus is asked at once.
   */
  async retryNow(): Promise<AbacusReachability> {
    const troubled = this.current !== "online" || this.failures > 0;
    this.resetBackoff();
    if (troubled) await this.check();
    return this.published;
  }

  /** A call got an HTTP answer: Abacus is reachable, whatever it said. */
  answered(): void {
    if (
      this.failures === 0 &&
      this.troubleSince == null &&
      this.current === "online"
    )
      return;
    this.recovered(false, true);
  }

  /**
   * A call to Abacus threw. Only a failure to get any answer counts, and
   * only once per step: a call that went out before the step was counted,
   * or during its hold (a user's, which is never held), fails as part of it.
   */
  failed(source: string, error: unknown, startedAt: number): void {
    if (!isNetworkFailure(error)) return;
    this.troubleSince ??= this.now();
    if (startedAt < this.lastStepAt || startedAt < this.holdUntil) return;
    this.step(`${source}: ${short(error)}`);
    // Whether it is the network or Abacus is the probe's call.
    if (this.current === "online") this.reportFailure();
  }

  /** Re-read the OS and probe the Abacus API, then publish what changed. */
  async check(
    options: { resumed?: boolean; retry?: boolean } = {}
  ): Promise<void> {
    if (this.probing != null) {
      await this.probing;
      if (options.resumed === true) this.publish(this.current, true);
      return;
    }
    const resumed = options.resumed === true;
    this.probing = (async () => {
      if (this.osOnline != null && !this.osOnline()) {
        if (!this.set("offline", resumed) && options.retry === true)
          this.step("no network");
        return;
      }
      const reachable = await this.probe();
      this.lastProbeAt = this.now();
      if (reachable) {
        this.recovered(resumed, false);
        return;
      }
      // Nothing resolves at all: offline, whatever the OS says.
      const offline = !(await this.internet());
      if (
        !this.set(offline ? "offline" : "degraded", resumed) &&
        options.retry === true
      )
        this.step(offline ? "no internet" : "probe: no answer");
    })();
    try {
      await this.probing;
    } finally {
      this.probing = null;
      this.scheduleRetry();
      this.refreshReach();
    }
  }

  private readOs(): void {
    if (this.asleep || this.osOnline == null) return;
    const up = this.osOnline();
    const was = this.osUp;
    this.osUp = up;
    if (!up && this.current !== "offline") {
      this.set("offline", false);
      this.scheduleRetry();
      this.refreshReach();
    }
    // The OS says a network is back: whether Abacus answers is the probe's call.
    else if (up && !was) {
      this.resetBackoff();
      void this.check();
    }
  }

  /** Not online: true when this counted as a failed try of its own. */
  private set(
    next: Exclude<ConnectivityState, "online">,
    resumed: boolean
  ): boolean {
    const changed = next !== this.current;
    this.current = next;
    this.troubleSince ??= this.now();
    // Not online with nothing counted yet: this is the first failed try.
    const stepped = this.failures === 0;
    if (stepped)
      this.step(next === "offline" ? "no network" : "probe: no answer");
    if (changed || resumed) this.publish(next, resumed);
    return stepped;
  }

  /** One more failed try: hold background calls for the next step. */
  private step(reason: string): void {
    const now = this.now();
    this.failures += 1;
    this.lastStepAt = now;
    this.toldRecovery = false;
    const delay =
      BACKOFF_MS[Math.min(this.failures - 1, BACKOFF_MS.length - 1)]!;
    this.holdUntil = now + delay;
    this.log(
      `[connectivity] can't reach Abacus (${reason}); background calls retry in ${duration(delay)} (failure ${this.failures})`
    );
    this.scheduleRetry();
    this.armHold();
    this.refreshReach();
  }

  /**
   * Abacus answered. A call's answer starts the backoff over; the probe's
   * only says the network is back, so calls that kept failing while it
   * answered stay held until one of them gets through.
   */
  private recovered(resumed: boolean, byCall: boolean): void {
    const changed = this.current !== "online";
    // One line per recovery: the probe's, or the first call through after it.
    if (changed || (byCall && this.failures > 0 && !this.toldRecovery)) {
      this.log(
        `[connectivity] Abacus reachable again${
          this.troubleSince != null
            ? ` after ${duration(this.now() - this.troubleSince)}`
            : ""
        } (${this.failures} failed ${this.failures === 1 ? "try" : "tries"})`
      );
      this.toldRecovery = true;
    }
    this.troubleSince = null;
    this.current = "online";
    if (byCall) this.resetBackoff();
    else this.wake();
    if (changed || resumed) this.publish("online", resumed);
    this.scheduleRetry();
    this.refreshReach();
  }

  private resetBackoff(): void {
    this.failures = 0;
    this.holdUntil = 0;
    this.lastStepAt = Number.NEGATIVE_INFINITY;
    this.clearTimer("holdTimer");
    // A notice already up stays until Abacus answers; one not up starts its wait again.
    if (this.published.state === "ok" && this.troubleSince != null)
      this.troubleSince = this.now();
    this.wake();
  }

  /** While not online, the probe is the retry: one per step. */
  private scheduleRetry(): void {
    this.clearTimer("retryTimer");
    if (this.current === "online") return;
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        if (!this.asleep) void this.check({ retry: true });
      },
      Math.max(0, this.holdUntil - this.now())
    );
    this.retryTimer.unref?.();
  }

  /** While online but held, waiters go when the hold ends. */
  private armHold(): void {
    this.clearTimer("holdTimer");
    const left = this.holdUntil - this.now();
    if (left <= 0) return;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.wake();
    }, left);
    this.holdTimer.unref?.();
  }

  private wake(): void {
    for (const waiter of Array.from(this.waiters)) waiter();
  }

  /** Work out what the notice shows, and tell its listeners when that moved. */
  private refreshReach(): void {
    this.clearTimer("noticeTimer");
    let next: AbacusReachability = { state: "ok", retryAt: null };
    if (this.current !== "online" && this.troubleSince != null) {
      const waited = this.now() - this.troubleSince;
      if (waited >= NOTICE_AFTER_MS || this.failures >= NOTICE_AFTER_FAILURES)
        next = {
          state: this.current === "offline" ? "offline" : "unreachable",
          retryAt: this.holdUntil > 0 ? this.holdUntil : null,
        };
      else {
        this.noticeTimer = setTimeout(() => {
          this.noticeTimer = null;
          this.refreshReach();
        }, NOTICE_AFTER_MS - waited);
        this.noticeTimer.unref?.();
      }
    }
    if (
      next.state === this.published.state &&
      next.retryAt === this.published.retryAt
    )
      return;
    this.published = next;
    for (const listener of Array.from(this.reachListeners)) {
      try {
        listener(next);
      } catch (error) {
        console.error("[connectivity] listener threw", error);
      }
    }
  }

  private clearTimer(which: "retryTimer" | "holdTimer" | "noticeTimer"): void {
    const timer = this[which];
    if (timer != null) clearTimeout(timer);
    this[which] = null;
  }

  private publish(state: ConnectivityState, resumed: boolean): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener({ state, resumed });
      } catch (error) {
        console.error("[connectivity] listener threw", error);
      }
    }
  }
}

/** Make `service` the owner every Abacus call reports to (abacus-calls.ts). */
export const installConnectivity = (
  service: ConnectivityService
): ConnectivityService => {
  installAbacusCallSink(service);
  return service;
};
