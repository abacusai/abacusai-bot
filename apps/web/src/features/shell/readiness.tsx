/**
 * The swap readiness barrier (spec 00 A.4.6; spec 01 §6.1, R1-T20). Mounted in
 * `__root`, so every entry route reports, shell or bare. After the first
 * commit it waits for `prefs`, `sessions` and `workspaces` to be ready and
 * calls `window.ready({ barrier: "subscriptions" })` once per document; if one
 * of them errors first it reports `failed`. Navigation and HMR never repeat it.
 */
import { useEffect } from "react";

import type { Collections } from "#renderer/data/db";
import type { Transport } from "#renderer/data/transport";

const REPORTED = Symbol.for("abacus.readinessReported");

type ReadyGlobal = { [REPORTED]?: boolean };

type Watched = Pick<Collections, "prefs" | "sessions" | "workspaces">;

const READINESS_TABLES = ["prefs", "sessions", "workspaces"] as const;

/** Resolves the barrier to report; exported for tests. */
const watchReadiness = (
  collections: Watched,
  report: (
    barrier:
      | { barrier: "subscriptions" }
      | { barrier: "failed"; reason: string }
  ) => void,
  store: ReadyGlobal = globalThis as ReadyGlobal
): (() => void) => {
  if (store[REPORTED]) return () => undefined;
  const subscriptions: Array<() => void> = [];
  let done = false;

  const settle = (): void => {
    if (done) return;
    const tables = READINESS_TABLES.map((name) => collections[name]);
    const failed = READINESS_TABLES.find(
      (name) => collections[name].status === "error"
    );
    if (failed !== undefined) {
      done = true;
      store[REPORTED] = true;
      report({ barrier: "failed", reason: `${failed} failed to load` });
    } else if (tables.every((collection) => collection.status === "ready")) {
      done = true;
      store[REPORTED] = true;
      report({ barrier: "subscriptions" });
    }
    if (done) for (const unsubscribe of subscriptions) unsubscribe();
  };

  for (const name of READINESS_TABLES)
    subscriptions.push(collections[name].on("status:change", settle));
  settle();
  return () => {
    for (const unsubscribe of subscriptions) unsubscribe();
  };
};

export const resetReadinessForTests = (): void => {
  delete (globalThis as ReadyGlobal)[REPORTED];
};

export const ReadinessReporter = ({
  transport,
  collections,
}: {
  transport: Transport;
  collections: Watched;
}): null => {
  // An effect: runs after the first commit.
  useEffect(
    () =>
      watchReadiness(collections, (barrier) => {
        void transport.client.window.ready(barrier).catch(() => undefined);
      }),
    [collections, transport]
  );
  return null;
};
