/**
 * The one place that decides whether and how the user hears that something
 * long-lived stopped: a routine, a chat-app lane, a run, the agent. Reporters
 * state facts (`report`); the board keeps what it last told per key on disk,
 * tells only when that changes, and picks the channels from one policy table:
 * the in-app list (always), a native notification from main, and a line in
 * the user's own chat app. Notices within a minute merge into one; quiet hours
 * hold native and chat sends; a daily cap bounds native ones.
 */
import * as fs from "node:fs";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";
import type { PlanT } from "@abacus-ai/contract/billing-plan";
import {
  messagingPlatformSpec,
  type MessagingPlatformId,
} from "@abacus-ai/contract/messaging";
import { ROUTINE_QUIET_RUNS_BEFORE_PAUSE } from "@abacus-ai/contract/routines";
import type {
  StatusDetail,
  StatusItem,
  StatusKey,
  StatusReason,
  StatusState,
} from "@abacus-ai/contract/status";
import { isStopState } from "@abacus-ai/contract/status";

/** Notices this close together go out as one. */
export const STATUS_MERGE_MS = 60_000;
/** Reports this close are one batch: a wake's missed routines sum into one notice. */
export const STATUS_BATCH_MS = 2_000;
/** Native notices per local day; past it the in-app line alone says it. */
export const STATUS_NATIVE_DAILY_CAP = 5;
/** A lane retrying by itself: shown after this, one native notice after the next. */
export const LANE_WAITING_SHOW_MS = 10 * 60_000;
export const LANE_WAITING_NOTIFY_MS = 60 * 60_000;
/** A lane told down is not told down again within this, however often it flaps. */
export const LANE_FLAP_COOLDOWN_MS = 30 * 60_000;
/** How often held (quiet-hours) notices look for the end of quiet hours. */
const QUIET_RECHECK_MS = 60_000;

type Channel = "native" | "chat";

/**
 * The policy table (design §3.3). `chat`: `lane` is the routine's own chat
 * app, `other` a live one that is not the dead lane. `waiting` notifies only
 * past its threshold, and only lanes have one (a routine escalates to missed).
 */
const POLICY: Record<
  Exclude<StatusState, "running">,
  { native: boolean; chat: "lane" | "other" | null }
> = {
  waiting: { native: false, chat: null },
  "paused-by-app": { native: true, chat: "lane" },
  "stopped-needs-user": { native: true, chat: "other" },
  missed: { native: true, chat: null },
  // The run's chat shows it; a chat app it answered is owed by the turn ledger.
  stopped: { native: false, chat: null },
};

/** What the board last told for one key, kept across restarts. */
interface Told {
  state: StatusState;
  reason: StatusReason;
  at: number;
  /** Told in a chat app, so coming back is said there too. */
  chat?: string | null;
  /** Channels quiet hours (or a restart) held back, still owed. */
  owed?: Channel[];
  /** `missed`: the finding it told (its `detail.at`); a new finding is told again. */
  event?: number;
}

interface StoredBoard {
  told: Record<string, Told>;
  /** When each lane's stop was last told: a lane that flaps is told once per cooldown. */
  laneToldAt?: Record<string, number>;
  /** Local day and native notices sent on it, for the daily cap. */
  day?: string;
  native?: number;
}

export interface StatusNotice {
  title: string;
  body: string;
  /** The item clicking it opens; the first when merged. */
  key: StatusKey;
  detail: StatusDetail;
}

export interface ChatNotice {
  /** Stable for one telling (its items and when they were told): the outbox dedupes on it. */
  id: string;
  text: string;
  /** Routines wait for credits: the chat app's own credits line, with its way on, leads. */
  credits?: boolean;
  /** The chat app to say it in, else the first live one. */
  platform: string | null;
  /** A lane that cannot carry it (the dead one). */
  avoid: string | null;
}

export interface StatusBoardDeps {
  /** status.json; null keeps nothing on disk (the hosted host, tests). */
  file: () => string | null;
  now?: () => number;
  log?: (line: string) => void;
  /** The in-app list changed. */
  changed?: () => void;
  words: () => Promise<{ t: PlanT }>;
  /** A native notification from main, which works with the window closed. */
  notify?: (notice: StatusNotice) => void;
  /** The window is focused: in-app shows it, native is skipped. */
  windowFocused?: () => boolean;
  /**
   * A line in the user's own chat app. The one seam a chat-app outbox (with
   * its own dedupe, flush on connect and drop) plugs into; false when unsent.
   */
  tellChat?: (notice: ChatNotice) => Promise<boolean>;
  quiet?: (now: Date) => boolean;
}

/** How each reporter speaks to the board. */
export interface StatusReporter {
  report(
    key: StatusKey,
    state: StatusState,
    reason: StatusReason,
    detail?: StatusDetail
  ): void;
  /** Back to running, but only from a stop this reporter owns (one of `reasons`). */
  clear(key: StatusKey, reasons: readonly StatusReason[]): void;
}

/** The causes a routine stop is reported with (the credits governor's list). */
export type RoutineStopCause =
  | "network-hold"
  | "credit-hold"
  | "run-budget"
  | "quiet-pause"
  | "failing-pause"
  | "link-down"
  | "signed-out"
  | "needs-account"
  | "user-pause";

const ROUTINE_STOPS: Record<
  Exclude<RoutineStopCause, "user-pause">,
  { state: StatusState; reason: StatusReason }
> = {
  "network-hold": { state: "waiting", reason: "network" },
  "credit-hold": { state: "stopped-needs-user", reason: "credits-out" },
  "run-budget": { state: "paused-by-app", reason: "credits" },
  "quiet-pause": { state: "paused-by-app", reason: "quiet" },
  "failing-pause": { state: "paused-by-app", reason: "failing" },
  "link-down": { state: "paused-by-app", reason: "link-lost" },
  "signed-out": { state: "stopped-needs-user", reason: "signed-out" },
  "needs-account": { state: "stopped-needs-user", reason: "needs-account" },
};

interface Pending {
  key: StatusKey;
  state: StatusState;
  reason: StatusReason;
  detail: StatusDetail;
  channels: Channel[];
}

const localDay = (at: number): string => {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

export class StatusBoard implements StatusReporter {
  private readonly items = new Map<StatusKey, StatusItem>();
  private stored: StoredBoard = { told: {} };
  private loaded = false;
  /** Keys re-reported during a launch reconcile; the rest are dropped. */
  private reconciling: Set<StatusKey> | null = null;
  private readonly waitTimers = new Map<
    StatusKey,
    ReturnType<typeof setTimeout>[]
  >();
  private pending: Pending[] = [];
  private lastSentAt = -Infinity;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private quietTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: StatusBoardDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Everything not running, for the in-app rows and banner. */
  list(): StatusItem[] {
    return [...this.items.values()].filter((item) => this.visible(item.key));
  }

  get(key: StatusKey): StatusItem | null {
    return this.items.get(key) ?? null;
  }

  /** Whether the item shows in-app yet (a lane's short blip does not). */
  visible(key: StatusKey): boolean {
    const item = this.items.get(key);
    if (item == null) return false;
    if (item.state !== "waiting" || !key.startsWith("lane:")) return true;
    return this.now() - item.since >= LANE_WAITING_SHOW_MS;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Launch: every reporter re-reports what it knows inside `run`. A stop
   * from an older build, from sleep, or from while the app was closed is told
   * now; a key nobody re-reported (a deleted routine) is dropped untold.
   */
  reconcile(run: () => void): void {
    this.load();
    this.reconciling = new Set();
    try {
      run();
    } finally {
      const seen = this.reconciling;
      this.reconciling = null;
      let dropped = false;
      for (const key of Object.keys(this.stored.told) as StatusKey[])
        if (!seen.has(key) && !this.items.has(key)) {
          delete this.stored.told[key];
          dropped = true;
        }
      if (dropped) this.save();
      this.queueOwed();
    }
  }

  report(
    key: StatusKey,
    state: StatusState,
    reason: StatusReason,
    detail: StatusDetail = {}
  ): void {
    this.load();
    this.reconciling?.add(key);
    const previous = this.items.get(key) ?? null;
    const was = previous?.state ?? "running";
    if (was !== state || previous?.reason !== reason)
      this.deps.log?.(
        `[status] ${key} ${was}${previous != null ? ` (${previous.reason})` : ""} -> ${state} (${reason})`
      );
    if (state === "running") {
      this.items.delete(key);
      this.clearWait(key);
    } else {
      // A new missed finding is a new item, not the old one still standing.
      const same =
        previous?.state === state &&
        previous.reason === reason &&
        (state !== "missed" || previous.detail.at === detail.at);
      this.items.set(key, {
        key,
        state,
        reason,
        since: same ? previous.since : this.now(),
        detail: { ...previous?.detail, ...detail },
      });
      if (!same) {
        this.clearWait(key);
        if (state === "waiting") this.armWait(key);
      }
    }
    if (
      was !== state ||
      previous?.reason !== reason ||
      detail.count !== previous?.detail.count ||
      detail.at !== previous?.detail.at
    )
      this.emit();
    // What it was known by, for the "back on" line after the item is gone.
    try {
      this.decide(key, state, reason, { ...previous?.detail, ...detail });
    } catch (error) {
      // Telling must never break the reporter (a routine fire, a lane change).
      this.deps.log?.(`[status] telling ${key} failed: ${String(error)}`);
    }
  }

  /** Gone (a deleted routine): dropped from the list and what was told, untold. */
  forget(key: StatusKey): void {
    this.load();
    this.clearWait(key);
    const had = this.items.delete(key);
    if (this.stored.told[key] != null) {
      delete this.stored.told[key];
      this.save();
    }
    if (had) this.emit();
  }

  clear(key: StatusKey, reasons: readonly StatusReason[]): void {
    const item = this.items.get(key);
    if (item != null && reasons.includes(item.reason))
      this.report(key, "running", "ok");
  }

  /** A routine stopped for `cause`, or came back (`null`); the credits governor reports here. */
  routineStopped(
    routineId: string,
    cause: RoutineStopCause | null,
    detail: StatusDetail = {}
  ): void {
    const key: StatusKey = `routine:${routineId}`;
    if (cause == null || cause === "user-pause") {
      // The user's own pause is theirs: logged, never told as a stop.
      if (cause === "user-pause")
        this.deps.log?.(`[status] ${key} paused by the user`);
      this.report(key, "running", "ok", detail);
      return;
    }
    const stop = ROUTINE_STOPS[cause];
    this.report(key, stop.state, stop.reason, { routineId, ...detail });
  }

  dispose(): void {
    for (const key of this.waitTimers.keys()) this.clearWait(key);
    if (this.flushTimer != null) clearTimeout(this.flushTimer);
    if (this.quietTimer != null) clearInterval(this.quietTimer);
    this.flushTimer = null;
    this.quietTimer = null;
  }

  /** Whether this change is told, and where: the policy table against what was told. */
  private decide(
    key: StatusKey,
    state: StatusState,
    reason: StatusReason,
    detail: StatusDetail
  ): void {
    const told = this.stored.told[key];
    if (
      told?.state === state &&
      told.reason === reason &&
      (state !== "missed" || told.event === detail.at)
    )
      return;
    if (state === "running") {
      if (told == null) return;
      delete this.stored.told[key];
      this.save();
      // Back on, said only where the stop was told.
      if (isStopState(told.state) && told.chat !== undefined)
        this.enqueue({ key, state, reason, detail, channels: ["chat"] });
      return;
    }
    // A wait is in-app only until its threshold (armWait) says otherwise.
    if (state === "waiting") return;
    const policy = POLICY[state];
    // A lane down again within the cooldown is shown in-app, not told again.
    const lastToldAt = this.stored.laneToldAt?.[key];
    const flapping =
      key.startsWith("lane:") &&
      lastToldAt != null &&
      this.now() - lastToldAt < LANE_FLAP_COOLDOWN_MS;
    const channels: Channel[] = flapping
      ? []
      : [
          ...(policy.native ? (["native"] as const) : []),
          ...(policy.chat != null && this.deps.tellChat != null
            ? (["chat"] as const)
            : []),
        ];
    if (key.startsWith("lane:") && !flapping)
      this.stored.laneToldAt = {
        ...this.stored.laneToldAt,
        [key]: this.now(),
      };
    const chatLane =
      policy.chat === "lane" && reason !== "lane-off" && reason !== "link-lost"
        ? (detail.platform ?? null)
        : null;
    this.stored.told[key] = {
      state,
      reason,
      at: this.now(),
      ...(channels.includes("chat") ? { chat: chatLane ?? null } : {}),
      ...(channels.length > 0 ? { owed: channels } : {}),
      ...(state === "missed" && detail.at != null ? { event: detail.at } : {}),
    };
    this.save();
    if (channels.length > 0)
      this.enqueue({ key, state, reason, detail, channels });
  }

  /** A lane retrying by itself: shown after a while, one notice after an hour. */
  private armWait(key: StatusKey): void {
    if (!key.startsWith("lane:")) return;
    const show = setTimeout(() => this.emit(), LANE_WAITING_SHOW_MS);
    const notify = setTimeout(() => {
      const item = this.items.get(key);
      if (item?.state !== "waiting") return;
      this.stored.told[key] = {
        state: "waiting",
        reason: item.reason,
        at: this.now(),
        owed: ["native"],
      };
      this.save();
      this.enqueue({
        key,
        state: "waiting",
        reason: item.reason,
        detail: item.detail,
        channels: ["native"],
      });
    }, LANE_WAITING_NOTIFY_MS);
    show.unref?.();
    notify.unref?.();
    this.waitTimers.set(key, [show, notify]);
  }

  private clearWait(key: StatusKey): void {
    for (const timer of this.waitTimers.get(key) ?? []) clearTimeout(timer);
    this.waitTimers.delete(key);
  }

  /** Owed sends from the last run (quiet hours, a quit before the flush). */
  private queueOwed(): void {
    for (const [key, told] of Object.entries(this.stored.told) as [
      StatusKey,
      Told,
    ][]) {
      const item = this.items.get(key);
      if (told.owed == null || item == null || item.state !== told.state)
        continue;
      if (this.pending.some((entry) => entry.key === key)) continue;
      this.enqueue({
        key,
        state: told.state,
        reason: told.reason,
        detail: item.detail,
        channels: told.owed,
      });
    }
  }

  /** Sent after a short batch, or merged into the next flush when one went out under a minute ago. */
  private enqueue(entry: Pending): void {
    this.pending = [
      ...this.pending.filter((other) => other.key !== entry.key),
      entry,
    ];
    if (this.quiet()) return this.holdForQuiet();
    if (this.flushTimer != null) return;
    const now = this.now();
    const at = Math.max(
      now + STATUS_BATCH_MS,
      this.lastSentAt + STATUS_MERGE_MS
    );
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.quiet()) return this.holdForQuiet();
      void this.flush();
    }, at - now);
    this.flushTimer.unref?.();
  }

  private quiet(): boolean {
    return this.deps.quiet?.(new Date(this.now())) === true;
  }

  private holdForQuiet(): void {
    if (this.quietTimer != null) return;
    this.quietTimer = setInterval(() => {
      if (this.quiet()) return;
      if (this.quietTimer != null) clearInterval(this.quietTimer);
      this.quietTimer = null;
      void this.flush();
    }, QUIET_RECHECK_MS);
    this.quietTimer.unref?.();
  }

  /** One native notice for everything pending, and one chat line per chat app. */
  private async flush(): Promise<void> {
    // Still the state it was queued for; a stop that cleared meanwhile is not said.
    // A missed summary stays true whatever came after it.
    const due = this.pending.filter((entry) =>
      entry.state === "running"
        ? !this.items.has(entry.key)
        : entry.state === "missed" ||
          this.items.get(entry.key)?.state === entry.state
    );
    this.pending = [];
    if (due.length === 0) return;
    this.lastSentAt = this.now();
    const words = await this.deps.words();
    const native = due.filter((entry) => entry.channels.includes("native"));
    if (native.length > 0) this.sendNative(native, words.t);
    const chat = due.filter((entry) => entry.channels.includes("chat"));
    for (const [target, entries] of this.byChat(chat)) {
      const credits = entries.some(
        (entry) => entry.state !== "running" && entry.reason === "credits-out"
      );
      const text = entries
        .filter((entry) => !(credits && entry.reason === "credits-out"))
        .map((entry) => chatLine(entry, words.t))
        .join("\n");
      const avoid = entries.map(deadLaneOf).find((lane) => lane != null);
      try {
        await this.deps.tellChat?.({
          id: `status:${entries.map((entry) => `${entry.key}:${entry.state}:${this.stored.told[entry.key]?.at ?? this.lastSentAt}`).join(",")}`,
          text,
          ...(credits ? { credits: true } : {}),
          platform: target,
          avoid: avoid ?? null,
        });
      } catch (error) {
        this.deps.log?.(`[status] chat notice failed: ${String(error)}`);
      }
    }
    for (const entry of due) {
      const told = this.stored.told[entry.key];
      if (told?.owed != null) delete told.owed;
    }
    this.save();
  }

  private byChat(entries: Pending[]): Map<string | null, Pending[]> {
    const groups = new Map<string | null, Pending[]>();
    for (const entry of entries) {
      // Back on: said on the lane that came back. A stop: on the routine's
      // own app, unless that app is the dead one.
      const target =
        entry.state === "running"
          ? entry.key.startsWith("lane:")
            ? entry.key.slice("lane:".length)
            : (this.stored.told[entry.key]?.chat ??
              entry.detail.platform ??
              null)
          : deadLaneOf(entry) == null &&
              POLICY[entry.state as Exclude<StatusState, "running">].chat ===
                "lane"
            ? (entry.detail.platform ?? null)
            : null;
      groups.set(target, [...(groups.get(target) ?? []), entry]);
    }
    return groups;
  }

  private sendNative(entries: Pending[], t: PlanT): void {
    if (this.deps.notify == null || this.deps.windowFocused?.() === true)
      return;
    const day = localDay(this.now());
    if (this.stored.day !== day) {
      this.stored.day = day;
      this.stored.native = 0;
    }
    if ((this.stored.native ?? 0) >= STATUS_NATIVE_DAILY_CAP) {
      this.deps.log?.("[status] daily notice cap reached; in-app only");
      return;
    }
    this.stored.native = (this.stored.native ?? 0) + 1;
    const first = entries[0]!;
    this.deps.notify({
      ...nativeNotice(entries, t),
      key: first.key,
      detail: first.detail,
    });
  }

  private emit(): void {
    this.deps.changed?.();
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch (error) {
        this.deps.log?.(`[status] listener threw: ${String(error)}`);
      }
    }
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const file = this.deps.file();
    if (file == null) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as StoredBoard;
      if (parsed != null && typeof parsed.told === "object")
        this.stored = parsed;
    } catch {
      // Nothing told yet.
    }
  }

  private save(): void {
    const file = this.deps.file();
    if (file == null) return;
    try {
      writeFileAtomicSync(file, JSON.stringify(this.stored, null, 2));
    } catch (error) {
      // A failed save only risks telling once more after a restart.
      this.deps.log?.(`[status] could not save status.json: ${String(error)}`);
    }
  }
}

/** The chat app a stop is about, which cannot carry news of it. */
const deadLaneOf = (entry: Pending): string | null => {
  if (entry.state === "running") return null;
  if (entry.key.startsWith("lane:")) return entry.key.slice("lane:".length);
  return entry.reason === "lane-off" || entry.reason === "link-lost"
    ? (entry.detail.platform ?? null)
    : null;
};

/** What an item is called in a sentence: a routine's name, a lane's app. */
const subject = (entry: Pending, t: PlanT): string =>
  entry.key.startsWith("lane:")
    ? platformName(entry.key.slice("lane:".length), t)
    : (entry.detail.name ?? t("status.aRoutine"));

const platformName = (platform: string, t: PlanT): string => {
  const spec = messagingPlatformSpec(platform as MessagingPlatformId);
  return t(`messaging.platforms.${spec?.nameKey ?? platform}`);
};

/** The one-line title of a single item's notice. */
const titleOf = (entry: Pending, t: PlanT): string => {
  const name = subject(entry, t);
  const lane = entry.key.startsWith("lane:");
  switch (entry.state) {
    case "paused-by-app":
      return t("status.title.paused", { name });
    case "stopped-needs-user":
      if (!lane) return t("status.title.onHold", { name });
      return entry.reason === "link-lost"
        ? t("native.linkLostTitle", { platform: name })
        : entry.reason === "login-not-finished"
          ? t("status.title.laneStopped", { name })
          : t("native.laneDownTitle", { platform: name });
    case "waiting":
      return t("native.laneDownTitle", { platform: name });
    case "missed":
      return t("status.title.missed", { name });
    default:
      return name;
  }
};

/** What the notice body says for one item, by its reason (shared with the in-app line). */
const bodyOf = (entry: Pending, t: PlanT): string => {
  const name = subject(entry, t);
  const platform =
    entry.detail.platform != null
      ? platformName(entry.detail.platform, t)
      : t("status.yourChatApp");
  if (entry.state === "missed")
    return t("routines.alwaysOn.missed", { count: entry.detail.count ?? 1 });
  switch (entry.reason) {
    case "quiet":
      return t("routines.paused.quiet", {
        runs: ROUTINE_QUIET_RUNS_BEFORE_PAUSE,
      });
    case "failing":
      return t("routines.paused.failures");
    case "credits":
    case "credits-out":
      return t("routines.creditHold.notify");
    case "signed-out":
      return t("status.body.signedOut");
    case "needs-account":
      return t("status.body.routineNeedsAccount", {
        account: entry.detail.account ?? "",
      });
    case "link-lost":
    case "needs-login":
      return entry.key.startsWith("lane:")
        ? t("native.linkLostLane", { platform: name })
        : t("status.body.routineLinkLost", { platform });
    case "login-not-finished":
      return t("status.body.loginNotFinished", { platform: name });
    case "lane-off":
      return t("status.body.routineLaneOff", { platform });
    case "gave-up":
      return t("messaging.recovery.stopped", { platform: name });
    case "needs-user":
      return t("native.laneBlockedBody", { platform: name });
    case "retrying":
      return t("native.laneDownBody", { platform: name });
    default:
      return titleOf(entry, t);
  }
};

/** One notice for one item; several merge into a summary (missed runs summed). */
export const nativeNotice = (
  entries: readonly Pending[],
  t: PlanT
): { title: string; body: string } => {
  if (entries.length === 1)
    return { title: titleOf(entries[0]!, t), body: bodyOf(entries[0]!, t) };
  if (entries.every((entry) => entry.state === "missed")) {
    const runs = entries.reduce((sum, e) => sum + (e.detail.count ?? 1), 0);
    const madeUp = entries.reduce((sum, e) => sum + (e.detail.madeUp ?? 0), 0);
    return {
      title: t("status.title.missedMany"),
      body: t("status.body.missedMany", {
        count: runs,
        routines: entries.length,
        madeUp,
      }),
    };
  }
  return {
    title: t("status.title.many", { count: entries.length }),
    body: entries.map((entry) => titleOf(entry, t)).join(" · "),
  };
};

/** The chat-app line for one item: its body, or that it is back. */
const chatLine = (entry: Pending, t: PlanT): string =>
  entry.state === "running"
    ? t("status.chat.back", { name: subject(entry, t) })
    : `${titleOf(entry, t)}\n${bodyOf(entry, t)}`;
