/**
 * Boot before the router (spec 01 §8.6): the transport, `system.info` and the
 * prefs snapshot, each with its own timeout and typed failure. Route loading
 * captures errors into matches instead of rejecting, so boot must not depend
 * on a route. A failure renders the static BootFailure screen and tells main
 * (`window.ready({ barrier: "failed" })`) when a transport exists.
 *
 * The transport's close handler is registered the moment the transport
 * resolves (Codex r3 #7): a port that dies during boot is caught by the mount
 * guard in main.tsx; one that dies later reloads the document once.
 */
import type { QueryClient } from "@tanstack/react-query";

import type { Collections } from "#next/data/collections";
import { systemInfoQuery } from "#next/data/queries/system";
import type { CloseReason, Transport } from "#next/data/transport";
import type { SystemInfo } from "#shared/contract";

class BootTimeoutError extends Error {
  constructor(readonly step: BootStep) {
    super(`Boot step ${step} timed out`);
    this.name = "BootTimeoutError";
  }
}

export type BootStep = "transport" | "system" | "prefs";

export class BootError extends Error {
  constructor(
    readonly step: BootStep,
    readonly reason: unknown
  ) {
    super(
      `${step} unavailable: ${reason instanceof Error ? reason.message : String(reason)}`,
      { cause: reason }
    );
    this.name =
      step === "transport"
        ? "TransportUnavailableError"
        : step === "system"
          ? "SystemUnavailableError"
          : "PrefsUnavailableError";
  }
}

const BOOT_TIMEOUTS = { transport: 5_000, system: 3_000, prefs: 5_000 };

interface Boot {
  transport: Transport;
  system: SystemInfo;
  queryClient: QueryClient;
  collections: Collections;
}

export type BootResult =
  | { ok: true; boot: Boot }
  | { ok: false; error: BootError; transport: Transport | null };

const within = <T>(
  promise: Promise<T>,
  ms: number,
  step: BootStep
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BootTimeoutError(step)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

export interface BootstrapDeps {
  getTransport: () => Promise<Transport>;
  queryClient: QueryClient;
  /** Called once the transport exists; the collections sync over it. */
  getCollections: () => Collections;
  onTransportLost: (reason: CloseReason) => void;
  timeouts?: Partial<typeof BOOT_TIMEOUTS>;
}

export const bootstrap = async (deps: BootstrapDeps): Promise<BootResult> => {
  const timeouts = { ...BOOT_TIMEOUTS, ...deps.timeouts };
  let transport: Transport | null = null;
  const fail = async (step: BootStep, cause: unknown): Promise<BootResult> => {
    const error = new BootError(step, cause);
    if (transport !== null && transport.state === "open")
      await transport.client.window
        .ready({ barrier: "failed", reason: error.message })
        .catch(() => undefined);
    return { ok: false, error, transport };
  };

  try {
    transport = await within(
      deps.getTransport(),
      timeouts.transport,
      "transport"
    );
  } catch (error) {
    return fail("transport", error);
  }
  // Before anything else is awaited.
  transport.onClose(deps.onTransportLost);

  let system: SystemInfo;
  try {
    system = await within(
      deps.queryClient.fetchQuery(systemInfoQuery(transport.orpc)),
      timeouts.system,
      "system"
    );
  } catch (error) {
    return fail("system", error);
  }

  const collections = deps.getCollections();
  try {
    await within(collections.prefs.preload(), timeouts.prefs, "prefs");
    if (collections.prefs.status === "error")
      throw new Error("prefs snapshot failed");
  } catch (error) {
    return fail("prefs", error);
  }

  return {
    ok: true,
    boot: { transport, system, queryClient: deps.queryClient, collections },
  };
};

/** How recently a reload for a lost port happened, across the reload. */
const RELOAD_KEY = "abacus:transport-lost-reload-at";
export const RELOAD_DELAY_MS = 1_500;
export const LOOP_WINDOW_MS = 10_000;

export interface TransportLostDeps {
  stopSyncs(): void;
  notify(): void;
  reload(): void;
  showError(): void;
  now?: () => number;
  storage?: Pick<Storage, "getItem" | "setItem">;
  schedule?: (fn: () => void, ms: number) => void;
}

/**
 * The single, idempotent reaction to losing the port after boot: stop the
 * collection syncs, say so, reload once after 1.5 s. A second loss within
 * 10 s of that reload shows the error screen instead of looping.
 */
export const createTransportLostHandler = (
  deps: TransportLostDeps
): ((reason: CloseReason) => void) => {
  let handled = false;
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  return (reason) => {
    // Our own close() (a deliberate teardown) is not a loss.
    if (handled || reason === "explicit") return;
    handled = true;
    deps.stopSyncs();
    let last: number | null = null;
    try {
      const raw = deps.storage?.getItem(RELOAD_KEY);
      last = raw == null ? null : Number(raw);
    } catch {
      last = null;
    }
    if (last !== null && now() - last < LOOP_WINDOW_MS) {
      deps.showError();
      return;
    }
    try {
      deps.storage?.setItem(RELOAD_KEY, String(now()));
    } catch {
      // Without storage the loop guard is off; the reload still happens.
    }
    deps.notify();
    schedule(() => deps.reload(), RELOAD_DELAY_MS);
  };
};
