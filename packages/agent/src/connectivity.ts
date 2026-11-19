/**
 * Whether this machine can reach Abacus, as the agent process knows it. The
 * desktop's connectivity owner says so at spawn (ABACUSAI_BOT_CONNECTIVITY)
 * and on every change (the `connectivity` command); a failed request can also
 * ask the Abacus API directly.
 */
import { abacusV1BaseUrl } from "./abacus-endpoint.js";

export type Connectivity = "online" | "offline" | "degraded" | "unknown";

const parse = (raw: string | undefined): Connectivity =>
  raw === "online" || raw === "offline" || raw === "degraded" ? raw : "unknown";

let state: Connectivity = parse(process.env.ABACUSAI_BOT_CONNECTIVITY);
const restoredListeners = new Set<() => void>();

export const hostConnectivity = (): Connectivity => state;

/** The host's word on connectivity; `resumed` when the machine just woke. */
export function setHostConnectivity(next: string, resumed = false): void {
  const was = state;
  state = parse(next);
  // A wake is worth a retry even before anyone has re-checked the network.
  if ((state === "online" && was !== "online") || resumed)
    for (const listener of Array.from(restoredListeners)) listener();
}

/** Called when the network looks back: online again, or the machine woke. */
export function onConnectivityRestored(listener: () => void): () => void {
  restoredListeners.add(listener);
  return () => {
    restoredListeners.delete(listener);
  };
}

/** Sleeps older than this are forgotten; no budget counts back further. */
const SLEEP_HISTORY_MS = 24 * 60 * 60_000;

/** The host's power clock: when the current sleep began, and the last day's. */
let asleepSince: number | null = null;
let sleeps: Array<{ from: number; to: number }> = [];

/**
 * The host's word on a sleep (the `power` command): `to` null when the
 * machine is going to sleep, set once it woke. Sent at once on each, ahead of
 * any network probe, so a deadline read on wake already knows.
 */
export function setHostSleep(from: number, to: number | null): void {
  if (to == null) {
    asleepSince = from;
    return;
  }
  sleeps = [
    ...sleeps.filter((span) => to - span.to < SLEEP_HISTORY_MS),
    { from, to },
  ];
  asleepSince = null;
}

/**
 * Time the machine slept between `from` and `to`, a sleep not yet over
 * included: what a work-time budget must not count.
 */
export function asleepBetween(from: number, to: number): number {
  const spans =
    asleepSince != null
      ? [...sleeps, { from: asleepSince, to: Math.max(asleepSince, to) }]
      : sleeps;
  return spans.reduce(
    (total, span) =>
      total + Math.max(0, Math.min(to, span.to) - Math.max(from, span.from)),
    0
  );
}

let hostGone = false;
const goneListeners = new Set<() => void>();

/** Whether the host closed this process's stdin: no one is left to answer. */
export const hostIsGone = (): boolean => hostGone;

/** A host attached: someone is listening again. */
export function hostAttached(): void {
  hostGone = false;
}

/** The host went away; waits end so the process can exit. */
export function markHostGone(): void {
  if (hostGone) return;
  hostGone = true;
  for (const listener of Array.from(goneListeners)) listener();
}

export function onHostGone(listener: () => void): () => void {
  goneListeners.add(listener);
  return () => {
    goneListeners.delete(listener);
  };
}

const PROBE_TIMEOUT_MS = 5_000;

/** Any HTTP answer counts: the question is the network, not the account. */
const defaultProbe = async (): Promise<boolean> => {
  try {
    await fetch(`${abacusV1BaseUrl()}/models`, {
      method: "HEAD",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
};

let probe: () => Promise<boolean> = defaultProbe;

/** Whether the Abacus API answers at all right now. */
export const abacusReachable = (): Promise<boolean> => probe();

/** Tests replace the probe; null restores the real one. */
export function setReachabilityProbe(
  replacement: (() => Promise<boolean>) | null
): void {
  probe = replacement ?? defaultProbe;
}
