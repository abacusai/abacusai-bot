/**
 * The renderer's QueryClient (spec 01 §8.2). Local IPC, so `navigator.onLine`
 * never pauses a query, and main pushes invalidations instead of the window's
 * focus refetching.
 */
import { isDefinedError } from "@orpc/client";
import { QueryClient } from "@tanstack/react-query";

/** Only a transient UNAVAILABLE is worth retrying (spec 00 A.5). */
export const shouldRetry = (failureCount: number, error: unknown): boolean =>
  isDefinedError(error) &&
  (error as { code?: unknown }).code === "UNAVAILABLE" &&
  failureCount < 3;

export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: "always",
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: shouldRetry,
      },
      mutations: { networkMode: "always", retry: false },
    },
  });
