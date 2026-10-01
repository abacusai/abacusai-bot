/**
 * A collection's lifecycle status as React state: "idle" | "loading" |
 * "ready" | "error" | "cleaned-up". Sidebars show skeletons while loading and
 * an inline retry on error.
 */
import type { Collection } from "@tanstack/db";
import { useSyncExternalStore } from "react";

type AnyCollection = Pick<Collection<any, any, any>, "status" | "on">;

export const useCollectionStatus = (collection: AnyCollection) =>
  useSyncExternalStore(
    (onChange) => collection.on("status:change", onChange),
    () => collection.status
  );
