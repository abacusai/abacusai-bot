import type { PrefsPatch } from "@abacus-ai/contract/contract/rows";
/**
 * The app's DB collections (spec 00 B.3, spec 01 §8.3). Nothing is created at
 * import: `createDb(transport)` builds one set over a lazy transport, and
 * main.tsx calls `installDb()` once `bootstrap()` has resolved the document's
 * transport, so no collection starts syncing before the boot timeouts and the
 * close handler exist (§8.6 step 5). The set lives on a global symbol, so a
 * Vite HMR re-run of this module reuses the live collections instead of
 * opening a second set of streams. The router context is the one source:
 * loaders read it there, and the root hands the same instance to
 * components through `<DbProvider>` (`useDb`); tests make their own.
 *
 * `prefs`, `workspaces` and `sessions` sync at once (the shell needs them);
 * the rest start on first use or a route's `collection.preload()`.
 */
import { BasicIndex, createCollection } from "@tanstack/db";
import { createContext, use } from "react";

import {
  artifactsCollectionOptions,
  botsCollectionOptions,
  createUpdatePrefs,
  gitStateCollectionOptions,
  memoriesCollectionOptions,
  prefsCollectionOptions,
  routineRunsCollectionOptions,
  routinesCollectionOptions,
  sessionsCollectionOptions,
  workspacesCollectionOptions,
  type LazyTransport,
  type TableOverrides,
} from "./tables";

const buildCollections = (
  transport: LazyTransport,
  overrides: TableOverrides
) => ({
  prefs: createCollection(prefsCollectionOptions(transport, overrides)),
  workspaces: createCollection(
    workspacesCollectionOptions(transport, overrides)
  ),
  sessions: createCollection(sessionsCollectionOptions(transport, overrides)),
  bots: createCollection(botsCollectionOptions(transport, overrides)),
  routines: createCollection(routinesCollectionOptions(transport, overrides)),
  routineRuns: createCollection(
    routineRunsCollectionOptions(transport, overrides)
  ),
  artifacts: createCollection(artifactsCollectionOptions(transport, overrides)),
  memories: createCollection(memoriesCollectionOptions(transport, overrides)),
  gitState: createCollection(gitStateCollectionOptions(transport, overrides)),
});

export type Collections = ReturnType<typeof buildCollections>;

export interface Db {
  readonly collections: Collections;
  /**
   * The prefs write (B.2 provenance): sends exactly the leaves in `patch`,
   * each of which becomes the user's. ⌘B sends `{ sidebar: { pinned } }`.
   */
  updatePrefs(patch: PrefsPatch): Promise<void>;
  /**
   * Stops every sync for good (the transport is gone): no reopen, no retry,
   * and no restart when a mounted query or loader subscribes again.
   */
  stop(): void;
  readonly stopped: boolean;
}

export const createDb = (
  transport: LazyTransport,
  overrides: Omit<TableOverrides, "signal"> = {}
): Db => {
  const stopper = new AbortController();
  const collections = buildCollections(transport, {
    ...overrides,
    signal: stopper.signal,
  });
  // For the bots area's live queries: a check-in is the oldest of a bot's
  // routines (`orderBy` with a limit), and a bot's files join its sessions
  // on the session id. Without them TanStack DB scans: an artifact scan per
  // session (sessions × artifacts), and warns.
  collections.routines.createIndex((row) => row.createdAt, {
    indexType: BasicIndex,
  });
  collections.artifacts.createIndex((row) => row.sessionId, {
    indexType: BasicIndex,
  });
  const write = createUpdatePrefs(collections.prefs, transport);
  return {
    collections,
    updatePrefs: (patch) => write(patch),
    stop: () => stopper.abort(),
    get stopped() {
      return stopper.signal.aborted;
    },
  };
};

const GLOBAL_KEY = Symbol.for("abacus.db");

type DbGlobal = { [GLOBAL_KEY]?: Db };

/**
 * The document's collections, created on the first call over `transport`
 * (the one `bootstrap()` resolved); later calls, an HMR re-run included,
 * return the same set. Only for HMR: nothing reads the global otherwise.
 */
export const installDb = (transport: LazyTransport): Db => {
  const store = globalThis as DbGlobal;
  store[GLOBAL_KEY] ??= createDb(transport);
  return store[GLOBAL_KEY];
};

const DbContext = createContext<Db | null>(null);

export const DbProvider = DbContext.Provider;

/** The collections and the prefs writer, from the nearest `<DbProvider>`. */
export const useOptionalDb = (): Db | null => use(DbContext);

export const useDb = (): Db => {
  const db = useOptionalDb();
  if (db == null) throw new Error("useDb outside <DbProvider>");
  return db;
};

export const useCollections = (): Collections => useDb().collections;

export * from "./tables";
