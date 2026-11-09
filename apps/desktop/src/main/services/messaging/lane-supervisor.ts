import type {
  MessagingPlatformId,
  MessagingPlatformState,
  MessagingRecovery,
} from "@abacus-ai/contract/messaging";

/**
 * How a connector's `error` may be retried. `auto`: transient (a page that
 * failed to load, stayed blank or crashed). `when_disk_free`: once the disk has
 * room again. `user`: only the user can fix it (a bad credential).
 */
export type LaneRetry = "auto" | "when_disk_free" | "user";

export type LaneFailure = {
  retry: LaneRetry;
  /** The page loaded and never booted: a full boot spent for nothing. */
  stuckBoot?: boolean;
  /** The site's certificate was refused: retried a few times, then the user's. */
  cert?: boolean;
};

/** First retry delay; doubles per failed try up to LANE_RETRY_CAP_MS. */
export const LANE_RETRY_FIRST_MS = 10_000;
export const LANE_RETRY_CAP_MS = 5 * 60_000;
/** After this many stuck boots in a row, a lane is tried this rarely. */
export const LANE_STUCK_BOOTS = 3;
export const LANE_STUCK_RETRY_MS = 30 * 60_000;
/** Down this long, the timer stops: only a hint or the user tries again. */
export const LANE_GIVE_UP_MS = 24 * 60 * 60_000;
/** A lane on `connecting` this long, unchanged, is treated as down. */
export const LANE_CONNECTING_WATCHDOG_MS = 10 * 60_000;
/** Hints and syncs try a lane at most this often. */
export const LANE_HINT_GAP_MS = 30_000;
/** Down this long before the app says so in the pane. */
export const LANE_SHOW_AFTER_MS = 10 * 60_000;
/** Down this long before one OS notification (per outage). */
export const LANE_NOTIFY_AFTER_MS = 60 * 60_000;
/** Retries of a refused certificate before the lane waits for the user. */
export const LANE_CERT_TRIES = 3;
/** How often a lane parked on a full disk checks for space. */
const DISK_CHECK_MS = 10_000;

export type LaneSupervisorDeps = {
  now: () => number;
  random: () => number;
  /** The lane is switched on and configured. */
  shouldRun: (id: MessagingPlatformId) => boolean;
  /** A fresh connector: stop the old one, start a new one. */
  restart: (id: MessagingPlatformId) => Promise<void>;
  diskSpaceBack: () => boolean;
  /** Someone is at the computer right now. */
  userActive: () => boolean;
  /** One OS notification: the lane has been down for an hour. */
  notifyDown: (id: MessagingPlatformId) => void;
  /** The failure persists in a way only the user can fix: tell them, once per outage. */
  tellNeedsUser: (id: MessagingPlatformId) => void;
  /** Network, wake and focus events; returns the stop. Watched only while a lane is down. */
  watchHints: (hint: (reason: string) => void) => () => void;
  /** What the pane shows changed. */
  changed: () => void;
  log: (line: string) => void;
};

type Timer = ReturnType<typeof setTimeout>;

type Lane = {
  state: MessagingPlatformState;
  stateSince: number;
  failure: LaneFailure | null;
  /** Set while the lane should be connected and isn't. */
  downSince: number | null;
  /** Failed tries since the last hint or connect: the backoff step. */
  attempts: number;
  stuckBoots: number;
  /** Refused certificates in a row. */
  certFails: number;
  /** Stopped retrying: what is wrong needs the user (see LANE_CERT_TRIES). */
  needsUser: boolean;
  toldUser: boolean;
  lastTryAt: number;
  /** A restart of ours is running. */
  trying: boolean;
  nextTryAt: number | null;
  retryTimer: Timer | null;
  watchdog: Timer | null;
  showTimer: Timer | null;
  notifyTimer: Timer | null;
  /** The hour passed while nobody was at the computer: told on their return. */
  notifyOwed: boolean;
  notified: boolean;
};

/** ±50% around a base that doubles from LANE_RETRY_FIRST_MS to LANE_RETRY_CAP_MS. */
export const laneRetryDelayMs = (attempt: number, random: number): number => {
  const base = Math.min(
    LANE_RETRY_CAP_MS,
    LANE_RETRY_FIRST_MS * 2 ** Math.min(Math.max(attempt - 1, 0), 10)
  );
  return base * (0.5 + random);
};

/**
 * The one outer loop for chat-app lanes: a lane that should be connected and
 * isn't (an `error` it may retry, or `connecting` past the watchdog) is
 * restarted on a capped, jittered backoff until it connects, is turned off,
 * or needs the user. OS events only make it try sooner.
 */
export class LaneSupervisor {
  private readonly lanes = new Map<MessagingPlatformId, Lane>();
  private stopHints: (() => void) | null = null;

  constructor(private readonly deps: LaneSupervisorDeps) {}

  /** Every state the gateway records, with the connector's failure label. */
  noteState(
    id: MessagingPlatformId,
    state: MessagingPlatformState,
    failure?: LaneFailure
  ): void {
    const lane = this.lane(id);
    const now = this.deps.now();
    const entered = lane.state !== state;
    if (entered) lane.stateSince = now;
    lane.state = state;
    lane.failure = state === "error" ? (failure ?? { retry: "user" }) : null;
    this.clear(lane, "watchdog");

    switch (state) {
      case "error":
        lane.trying = false;
        if (lane.failure!.retry === "user") return this.settle(id, lane);
        lane.stuckBoots =
          lane.failure!.stuckBoot === true ? lane.stuckBoots + 1 : 0;
        lane.certFails = lane.failure!.cert === true ? lane.certFails + 1 : 0;
        // A different failure: no longer the one only the user can clear.
        if (lane.failure!.cert !== true) lane.needsUser = false;
        this.markDown(id, lane);
        if (lane.certFails > LANE_CERT_TRIES) return this.needUser(id, lane);
        this.schedule(id, lane);
        return;
      case "connecting":
        // The user opened a lane that is down (Connect): their try is running,
        // and a pending retry must not replace the page they are looking at.
        if (entered && lane.downSince != null && !lane.trying) {
          this.clear(lane, "retryTimer");
          lane.nextTryAt = null;
          lane.lastTryAt = now;
          lane.trying = true;
        }
        // From when it started connecting: a changed note is no progress.
        lane.watchdog = setTimeout(
          () => {
            lane.watchdog = null;
            if (lane.state !== "connecting" || !this.deps.shouldRun(id)) return;
            this.deps.log(
              `${id}: still connecting after 10 min, restarting it`
            );
            lane.trying = false;
            // A boot this slow costs a full boot each time: one restart soon,
            // then the stuck-boot pace.
            lane.failure = { retry: "auto", stuckBoot: true };
            lane.stuckBoots =
              lane.stuckBoots === 0
                ? 1
                : Math.max(LANE_STUCK_BOOTS, lane.stuckBoots + 1);
            this.markDown(id, lane);
            this.schedule(id, lane);
          },
          Math.max(0, lane.stateSince + LANE_CONNECTING_WATCHDOG_MS - now)
        );
        lane.watchdog.unref?.();
        return;
      // Our own restart passes through here; the outage carries on.
      case "disabled":
        if (lane.trying) return;
        return this.settle(id, lane);
      // Connected, or waiting on a person: not down.
      default:
        lane.stuckBoots = 0;
        return this.settle(id, lane);
    }
  }

  /** Network change, wake, focus, the Messaging page: try down lanes soon. */
  hint(reason: string): void {
    for (const [id, lane] of this.lanes) {
      if (lane.downSince == null || lane.trying || lane.needsUser) continue;
      if (lane.failure?.retry !== "auto") continue;
      if (lane.notifyOwed && this.deps.userActive()) this.notify(id, lane);
      const now = this.deps.now();
      // A page that loads but never boots costs a full boot: hints keep its slow pace.
      const gap =
        lane.stuckBoots >= LANE_STUCK_BOOTS
          ? LANE_STUCK_RETRY_MS
          : LANE_HINT_GAP_MS;
      const at = Math.max(
        now + 1_000 + this.deps.random() * 4_000,
        lane.lastTryAt + gap
      );
      if (lane.nextTryAt != null && lane.nextTryAt <= at) continue;
      // Brought forward: the backoff starts over from its first step.
      lane.attempts = 0;
      this.deps.log(`${id}: ${reason}, trying again soon`);
      this.arm(id, lane, at - now);
    }
  }

  /**
   * The user asked: Try now, or Connect on a lane in `error` (any kind).
   * `minGapMs` keeps a burst of settings saves from restarting it each time.
   */
  retryNow(id: MessagingPlatformId, minGapMs = 0): boolean {
    const lane = this.lanes.get(id);
    if (lane == null || lane.trying) return false;
    if (lane.state !== "error" && lane.downSince == null) return false;
    if (this.deps.now() - lane.lastTryAt < minGapMs) return false;
    lane.attempts = 0;
    void this.attempt(id, lane);
    return true;
  }

  /** The lane is down and this supervisor is bringing it back. */
  retrying(id: MessagingPlatformId): boolean {
    return this.lanes.get(id)?.downSince != null;
  }

  /** What the pane says: nothing until the lane has been down a while. */
  status(id: MessagingPlatformId): MessagingRecovery | null {
    const lane = this.lanes.get(id);
    if (lane?.downSince == null) return null;
    if (this.deps.now() - lane.downSince < LANE_SHOW_AFTER_MS) return null;
    const phase: MessagingRecovery["phase"] = lane.trying
      ? "trying"
      : lane.needsUser
        ? "needs_user"
        : lane.failure?.retry === "when_disk_free"
          ? "disk"
          : lane.nextTryAt == null
            ? "stopped"
            : "scheduled";
    return { phase, nextTryAt: phase === "scheduled" ? lane.nextTryAt : null };
  }

  /** Turned off, or the gateway is going away. */
  forget(id: MessagingPlatformId): void {
    const lane = this.lanes.get(id);
    if (lane == null) return;
    lane.trying = false;
    this.settle(id, lane);
    this.clear(lane, "watchdog");
    this.lanes.delete(id);
  }

  dispose(): void {
    for (const id of this.lanes.keys()) this.forget(id);
  }

  private lane(id: MessagingPlatformId): Lane {
    let lane = this.lanes.get(id);
    if (lane == null) {
      lane = {
        state: "disabled",
        stateSince: this.deps.now(),
        failure: null,
        downSince: null,
        attempts: 0,
        stuckBoots: 0,
        certFails: 0,
        needsUser: false,
        toldUser: false,
        lastTryAt: -Infinity,
        trying: false,
        nextTryAt: null,
        retryTimer: null,
        watchdog: null,
        showTimer: null,
        notifyTimer: null,
        notifyOwed: false,
        notified: false,
      };
      this.lanes.set(id, lane);
    }
    return lane;
  }

  private markDown(id: MessagingPlatformId, lane: Lane): void {
    if (lane.downSince != null) return;
    const now = this.deps.now();
    // A connecting watchdog: the outage began when it started connecting.
    lane.downSince = lane.state === "connecting" ? lane.stateSince : now;
    this.deps.log(`${id}: down, retrying by itself`);
    lane.showTimer = setTimeout(
      () => {
        lane.showTimer = null;
        this.deps.changed();
      },
      Math.max(0, lane.downSince + LANE_SHOW_AFTER_MS - now)
    );
    lane.showTimer.unref?.();
    lane.notifyTimer = setTimeout(
      () => {
        lane.notifyTimer = null;
        if (lane.downSince == null || lane.notified) return;
        if (this.deps.userActive()) this.notify(id, lane);
        else lane.notifyOwed = true;
      },
      Math.max(0, lane.downSince + LANE_NOTIFY_AFTER_MS - now)
    );
    lane.notifyTimer.unref?.();
    this.watchHintsWhileDown();
  }

  /** Retrying cannot fix it: stop, and tell the user once per outage. */
  private needUser(id: MessagingPlatformId, lane: Lane): void {
    this.deps.log(
      `${id}: the same failure keeps coming back, waiting for the user`
    );
    lane.needsUser = true;
    this.clear(lane, "retryTimer");
    lane.nextTryAt = null;
    if (!lane.toldUser) {
      lane.toldUser = true;
      this.deps.tellNeedsUser(id);
    }
    this.deps.changed();
  }

  private notify(id: MessagingPlatformId, lane: Lane): void {
    lane.notifyOwed = false;
    if (lane.notified) return;
    lane.notified = true;
    this.deps.notifyDown(id);
  }

  /** Back up, waiting on a person, or off: the outage is over. */
  private settle(id: MessagingPlatformId, lane: Lane): void {
    const wasDown = lane.downSince != null;
    lane.downSince = null;
    lane.attempts = 0;
    lane.nextTryAt = null;
    lane.notifyOwed = false;
    lane.notified = false;
    lane.certFails = 0;
    lane.needsUser = false;
    lane.toldUser = false;
    this.clear(lane, "retryTimer");
    this.clear(lane, "showTimer");
    this.clear(lane, "notifyTimer");
    if (wasDown) {
      this.deps.log(`${id}: no longer down (${lane.state})`);
      this.deps.changed();
    }
    this.watchHintsWhileDown();
  }

  private schedule(id: MessagingPlatformId, lane: Lane): void {
    const now = this.deps.now();
    if (lane.failure?.retry === "when_disk_free") {
      this.arm(id, lane, DISK_CHECK_MS);
      return;
    }
    if (now - lane.downSince! >= LANE_GIVE_UP_MS) {
      this.deps.log(`${id}: down for a day, waiting for the user`);
      this.clear(lane, "retryTimer");
      lane.nextTryAt = null;
      this.deps.changed();
      return;
    }
    const delay =
      lane.stuckBoots >= LANE_STUCK_BOOTS
        ? LANE_STUCK_RETRY_MS
        : laneRetryDelayMs(lane.attempts + 1, this.deps.random());
    this.arm(id, lane, delay);
  }

  private arm(id: MessagingPlatformId, lane: Lane, ms: number): void {
    this.clear(lane, "retryTimer");
    lane.nextTryAt = this.deps.now() + ms;
    lane.retryTimer = setTimeout(() => {
      lane.retryTimer = null;
      lane.nextTryAt = null;
      if (
        lane.failure?.retry === "when_disk_free" &&
        !this.deps.diskSpaceBack()
      ) {
        this.arm(id, lane, DISK_CHECK_MS);
        return;
      }
      void this.attempt(id, lane);
    }, ms);
    lane.retryTimer.unref?.();
    this.deps.changed();
  }

  private async attempt(id: MessagingPlatformId, lane: Lane): Promise<void> {
    this.clear(lane, "retryTimer");
    lane.nextTryAt = null;
    if (!this.deps.shouldRun(id)) {
      this.forget(id);
      return;
    }
    lane.trying = true;
    lane.attempts += 1;
    lane.lastTryAt = this.deps.now();
    this.deps.log(`${id}: restarting (try ${lane.attempts})`);
    this.deps.changed();
    try {
      await this.deps.restart(id);
    } catch (error) {
      this.deps.log(`${id}: restart failed: ${String(error)}`);
      lane.trying = false;
      if (this.lanes.get(id) === lane && lane.downSince != null)
        this.schedule(id, lane);
    }
    // From here the new connector's states drive the lane; `trying` ends
    // on its first settled state (error, connected, needs_login).
    if (lane.state !== "connecting" && lane.state !== "disabled")
      lane.trying = false;
  }

  /** Hint sources cost a poll, so they run only while some lane is down. */
  private watchHintsWhileDown(): void {
    const anyDown = [...this.lanes.values()].some(
      (lane) => lane.downSince != null
    );
    if (anyDown && this.stopHints == null)
      this.stopHints = this.deps.watchHints((reason) => this.hint(reason));
    else if (!anyDown && this.stopHints != null) {
      this.stopHints();
      this.stopHints = null;
    }
  }

  private clear(
    lane: Lane,
    key: "retryTimer" | "watchdog" | "showTimer" | "notifyTimer"
  ): void {
    const timer = lane[key];
    if (timer != null) clearTimeout(timer);
    lane[key] = null;
  }
}
