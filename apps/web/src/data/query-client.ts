/**
 * The renderer's QueryClient (spec 01 §8.2). Local IPC, so `navigator.onLine`
 * never pauses a query, and main pushes invalidations instead of the window's
 * focus refetching.
 *
 * Writes that are not DB rows go through `useMutation` with the procedure's
 * oRPC `mutationOptions` (DB rows stay on the collections' own handlers).
 * The transport still classifies each call by procedure (`transport/
 * intent.ts`), so a mutation is a write held until the sign-in gate
 * authorizes it, whichever hook sent it.
 */
import { isDefinedError } from "@orpc/client";
import {
  isCancelledError,
  MutationCache,
  QueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import { isHostUnavailable } from "#renderer/data/transport/lifecycle";
import { i18n } from "#renderer/lib/i18n";

/**
 * What a failed mutation toasts (`meta.errorToast`), chosen at each site:
 * - a copy key: that copy, whatever the error;
 * - `true`: the error's own message.
 */
export type ErrorToast = string | true;

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: {
      /** Query keys (prefixes) refetched once the mutation succeeds. */
      invalidates?: readonly QueryKey[];
      /**
       * Toasted when the mutation fails (`ErrorToast`). Unset, the call
       * site reports the failure.
       */
      errorToast?: ErrorToast;
    };
  }
}

/** Only a transient UNAVAILABLE is worth retrying (spec 00 A.5). */
const shouldRetry = (failureCount: number, error: unknown): boolean =>
  isDefinedError(error) &&
  (error as { code?: unknown }).code === "UNAVAILABLE" &&
  failureCount < 3;

export interface QueryClientOptions {
  /**
   * Shows `meta.errorToast`. The main window passes its toaster; the notch
   * document has none, and leaving it out keeps the toaster out of the
   * chunk the two documents share.
   */
  showError?: (title: string) => void;
}

/** The text `meta.errorToast` shows for `error`; null shows nothing. */
const toastText = (error: unknown, toast: ErrorToast): string | null => {
  // Cancelled by the page (an unmount, a superseded call): not a failure.
  if (isCancelledError(error)) return null;
  if ((error as { name?: unknown } | null)?.name === "AbortError") return null;
  // Never reached the host: one "not sent", whichever write it was.
  if (isHostUnavailable(error)) return i18n.t("chat.message.notSent");
  if (toast === true)
    return error instanceof Error ? error.message : String(error);
  return i18n.t(toast);
};

export const createQueryClient = ({
  showError,
}: QueryClientOptions = {}): QueryClient => {
  // Writes failing together (held writes revoked at once) show one toast
  // per text, not one per write.
  const shown = new Set<string>();
  const client: QueryClient = new QueryClient({
    mutationCache: new MutationCache({
      // Awaited: `mutateAsync` resolves once the invalidated keys refetched.
      onSuccess: (_data, _variables, _result, mutation) =>
        Promise.all(
          (mutation.meta?.invalidates ?? []).map((queryKey) =>
            client.invalidateQueries({ queryKey })
          )
        ),
      onError: (error, _variables, _result, mutation) => {
        const toast = mutation.meta?.errorToast;
        if (toast === undefined || !showError) return;
        const text = toastText(error, toast);
        if (text === null || shown.has(text)) return;
        shown.add(text);
        setTimeout(() => shown.delete(text), 0);
        showError(text);
      },
    }),
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
  return client;
};
