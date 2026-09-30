/**
 * The collections registry (spec 01 §8.3). One set per document, created on
 * first use over the configured source and kept on a global symbol so a Vite
 * HMR re-run of this module reuses the live collections instead of opening a
 * second set of streams. The router context and `<CollectionsProvider>` hand
 * the same instance to loaders and components.
 */
import { createContext, use } from "react";

import { transportDbSource, type DbSource } from "./table-source";
import { createCollections, type Collections } from "./tables";

const GLOBAL_KEY = Symbol.for("abacus.collections");

type CollectionsGlobal = {
  [GLOBAL_KEY]?: { collections: Collections | null; source: DbSource };
};

const slot = (): NonNullable<CollectionsGlobal[typeof GLOBAL_KEY]> => {
  const store = globalThis as CollectionsGlobal;
  store[GLOBAL_KEY] ??= { collections: null, source: transportDbSource };
  return store[GLOBAL_KEY];
};

/**
 * Route the tables somewhere else before the collections exist: the dev
 * fixture tables while main's `db.*` is not implemented yet.
 */
export const setDbSource = (source: DbSource): void => {
  const current = slot();
  if (current.collections !== null)
    throw new Error("setDbSource after the collections were created");
  current.source = source;
};

export const getCollections = (): Collections => {
  const current = slot();
  current.collections ??= createCollections(current.source);
  return current.collections;
};

const CollectionsContext = createContext<Collections | null>(null);

export const CollectionsProvider = CollectionsContext.Provider;

/** The document's collections (or a test's, through the provider). */
export const useCollections = (): Collections => {
  const provided = use(CollectionsContext);
  return provided ?? getCollections();
};

export { createCollections, type Collections } from "./tables";
export type { DbSource } from "./table-source";
