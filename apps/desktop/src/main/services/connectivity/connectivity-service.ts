/**
 * The one owner of "can this machine reach Abacus": the OS's own answer where
 * there is one (Electron's `net.isOnline`), sleep and wake, and a light probe
 * of the Abacus API, run only when something suggests the answer changed.
 * When Abacus does not answer, one neutral public URL tells whose fault it is.
 * Agents, the routine scheduler, the window's banner and anything else read
 * it from here, and deadlines that must not count the machine's sleep are
 * timed by it.
 */
import type { ConnectivitySnapshot } from "@abacus-ai/contract/status";

import { abacusRoutellmV1, abacusUserAgent } from "../providers/abacus-host";

/**
 * `offline`: no internet (the OS says so, or the public probe fails too).
 * `degraded`: the internet works, but the Abacus API does not answer.
 * Whoever only asks "can we work" treats both as not online.
 */
export type ConnectivityState = "online" | "offline" | "degraded";

export type { ConnectivitySnapshot };

export interface ConnectivityChange {
  state: ConnectivityState;
  /** The machine just woke: worth a retry even if the state did not move. */
  resumed: boolean;
}

/** One sleep, by the wall clock; `to` is null while it lasts. */
export interface SleepSpan {
  from: number;
  to: number | null;
}

export interface ConnectivityOptions {
  /** Whether the Abacus API answers at all. */
  probe?: () => Promise<boolean>;
  /** Whether the internet answers at all; asked only when Abacus does not. */
  publicProbe?: () => Promise<boolean>;
  /** The snapshot changed (state or next check); for the window. */
  changed?: (snapshot: ConnectivitySnapshot) => void;
  now?: () => number;
  /** The main log; suspend and resume each get a line. */
  log?: (line: string) => void;
}

/** Asleep this long with timers running means the resume event was lost. */
const MISSED_RESUME_MS = 60_000;
/** Sleeps older than this are forgotten; no deadline counts back further. */
const SLEEP_HISTORY_MS = 24 * 60 * 60_000;

/** How often the OS's own answer is read: a local call, no traffic. */
const OS_POLL_MS = 5_000;
/** While not online the probe backs off to this, never a hot loop. */
const PROBE_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
/** A fresh-enough answer for a caller about to start network work. */
const PROBE_FRESH_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;

/**
 * A well-known endpoint built for exactly this check: an empty 204, no
 * cookies, nothing about the user sent.
 */
const PUBLIC_PROBE_URL = "https://www.gstatic.com/generate_204";

/** Any HTTP answer counts: the question is whether the internet works. */
export const probePublic = async (): Promise<boolean> => {
  try {
    await fetch(PUBLIC_PROBE_URL, {
      method: "HEAD",
      credentials: "omit",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
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

/** A deadline counted in awake time; see awakeTimeout. */
interface AwakeTimer {
  ms: number;
  fire: () => void;
  handle: ReturnType<typeof setTimeout> | null;
}

export class ConnectivityService {
  private current: ConnectivityState = "online";
  private readonly listeners = new Set<(change: ConnectivityChange) => void>();
  private osOnline: (() => boolean) | null = null;
  private osTimer: ReturnType<typeof setInterval> | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private nextCheckAt: number | null = null;
  private since: number | null = null;
  /** The OS itself said offline: its "back" is worth a probe at once. */
  private osSaidOffline = false;
  private probeFailures = 0;
  private probing: Promise<void> | null = null;
  private lastProbeAt = 0;
  private asleep = false;
  /** The power clock: when the current sleep began, and the last day's sleeps. */
  private asleepSince: number | null = null;
  private sleeps: Array<{ from: number; to: number }> = [];
  private readonly awakeTimers = new Set<AwakeTimer>();
  private readonly sleepListeners = new Set<(span: SleepSpan) => void>();
  private readonly probe: () => Promise<boolean>;
  private readonly publicProbe: () => Promise<boolean>;
  private readonly changed: (snapshot: ConnectivitySnapshot) => void;
  private readonly now: () => number;

  constructor(options: ConnectivityOptions = {}) {
    this.probe = options.probe ?? probeAbacus;
    this.publicProbe = options.publicProbe ?? probePublic;
    this.changed = options.changed ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((line) => console.log(line));
  }

  private readonly log: (line: string) => void;

  /**
   * Time the machine slept between `from` and `to`, the current sleep
   * included: what a wall-clock deadline (the routine reaper) must not count.
   */
  asleepBetween(from: number, to: number): number {
    const spans =
      this.asleepSince != null
        ? [...this.sleeps, { from: this.asleepSince, to: this.now() }]
        : this.sleeps;
    return spans.reduce(
      (total, span) =>
        total + Math.max(0, Math.min(to, span.to) - Math.max(from, span.from)),
      0
    );
  }

  get state(): ConnectivityState {
    return this.current;
  }

  get online(): boolean {
    return this.current === "online";
  }

  snapshot(): ConnectivitySnapshot {
    return {
      state: this.current,
      since: this.since,
      nextCheckAt: this.nextCheckAt,
    };
  }

  /**
   * Each sleep as it starts (`to` null) and as it ends, at once and ahead of
   * any probe: for the agents' own work-time budgets.
   */
  onSleep(listener: (span: SleepSpan) => void): () => void {
    this.sleepListeners.add(listener);
    return () => {
      this.sleepListeners.delete(listener);
    };
  }

  private publishSleep(span: SleepSpan): void {
    for (const listener of Array.from(this.sleepListeners)) {
      try {
        listener(span);
      } catch (error) {
        console.error("[connectivity] sleep listener threw", error);
      }
    }
  }

  onChange(listener: (change: ConnectivityChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
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
    if (this.probeTimer != null) clearTimeout(this.probeTimer);
    this.osTimer = null;
    this.probeTimer = null;
    this.nextCheckAt = null;
  }

  /**
   * `fire` after `ms` of the machine being awake: put off while it sleeps
   * and given its whole window again on wake, so a deadline that came due in
   * the night does not fire the moment the lid opens. Returns its cancel.
   */
  awakeTimeout(ms: number, fire: () => void): () => void {
    const timer: AwakeTimer = { ms, fire, handle: null };
    this.awakeTimers.add(timer);
    if (!this.asleep) this.armAwake(timer);
    return () => {
      if (timer.handle != null) clearTimeout(timer.handle);
      this.awakeTimers.delete(timer);
    };
  }

  /**
   * Asleep by the books for over a minute while timers still run: the OS
   * never sent its resume. The caller (a tick) resumes it.
   */
  missedResume(): boolean {
    return (
      this.asleepSince != null &&
      this.now() - this.asleepSince > MISSED_RESUME_MS
    );
  }

  suspended(): void {
    if (!this.asleep) {
      this.asleepSince = this.now();
      this.log(
        `[power] suspend at ${new Date(this.asleepSince).toISOString()}`
      );
      this.publishSleep({ from: this.asleepSince, to: null });
    }
    this.asleep = true;
    for (const timer of this.awakeTimers) {
      if (timer.handle != null) clearTimeout(timer.handle);
      timer.handle = null;
    }
  }

  /** The machine woke: the network it had may be gone, or back. */
  resumed(): void {
    const now = this.now();
    if (this.asleepSince != null) {
      this.sleeps = [
        ...this.sleeps.filter((span) => now - span.to < SLEEP_HISTORY_MS),
        { from: this.asleepSince, to: now },
      ];
      this.log(
        `[power] resume at ${new Date(now).toISOString()} after ${Math.round((now - this.asleepSince) / 1000)}s asleep`
      );
      this.publishSleep({ from: this.asleepSince, to: now });
    } else this.log(`[power] resume at ${new Date(now).toISOString()}`);
    this.asleepSince = null;
    this.asleep = false;
    for (const timer of this.awakeTimers) this.armAwake(timer);
    void this.check({ resumed: true });
  }

  private armAwake(timer: AwakeTimer): void {
    if (timer.handle != null) clearTimeout(timer.handle);
    timer.handle = setTimeout(() => {
      this.awakeTimers.delete(timer);
      timer.fire();
    }, timer.ms);
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

  /** Re-read the OS and probe the Abacus API, then publish what changed. */
  async check(options: { resumed?: boolean } = {}): Promise<void> {
    if (this.probing != null) {
      await this.probing;
      if (options.resumed === true) this.publish(this.current, true);
      return;
    }
    this.probing = (async () => {
      if (this.osOnline != null && !this.osOnline()) {
        this.osSaidOffline = true;
        this.set("offline", options.resumed === true);
        return;
      }
      this.osSaidOffline = false;
      const reachable = await this.probe();
      // Abacus is silent: the internet as a whole says whose fault it is.
      const internet = reachable || (await this.publicProbe());
      this.lastProbeAt = this.now();
      this.set(
        reachable ? "online" : internet ? "degraded" : "offline",
        options.resumed === true
      );
    })();
    try {
      await this.probing;
    } finally {
      this.probing = null;
    }
  }

  private readOs(): void {
    if (this.asleep || this.osOnline == null) return;
    const up = this.osOnline();
    if (!up && !this.osSaidOffline) {
      this.osSaidOffline = true;
      if (this.current !== "offline") this.set("offline", false);
    }
    // The OS says a network is back: whether Abacus answers is the probe's
    // call. An offline the probes found waits for their own backoff.
    else if (up && this.osSaidOffline) {
      this.osSaidOffline = false;
      void this.check();
    }
  }

  private set(next: ConnectivityState, resumed: boolean): void {
    const changed = next !== this.current;
    if (changed)
      this.since =
        next === "online"
          ? null
          : this.current === "online"
            ? this.now()
            : this.since;
    this.current = next;
    this.scheduleProbe(changed);
    this.changed(this.snapshot());
    if (changed || resumed) this.publish(next, resumed);
  }

  /** While not online, probe again on a backoff; once online, stop. */
  private scheduleProbe(changed: boolean): void {
    if (this.probeTimer != null) clearTimeout(this.probeTimer);
    this.probeTimer = null;
    this.nextCheckAt = null;
    if (this.current === "online") {
      this.probeFailures = 0;
      return;
    }
    if (changed) this.probeFailures = 0;
    const delay =
      PROBE_BACKOFF_MS[
        Math.min(this.probeFailures, PROBE_BACKOFF_MS.length - 1)
      ]!;
    this.probeFailures += 1;
    this.nextCheckAt = this.now() + delay;
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      this.nextCheckAt = null;
      if (!this.asleep) void this.check();
    }, delay);
    this.probeTimer.unref?.();
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
