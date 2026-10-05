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
  hashKey,
  isCancelledError,
  MutationCache,
  QueryClient,
  type DataTag,
  type MutationFunctionContext,
  type QueryKey,
} from "@tanstack/react-query";

import { isHostUnavailable } from "#renderer/data/transport/lifecycle";
import { i18n } from "#renderer/lib/i18n";

/**
 * What a failed mutation toasts (`meta.errorToast`), chosen at each site:
 * - a copy key: that copy, whatever the error;
 * - `true`: the error's own message;
 * - `{ reasonOr: key }`: main's reason from a `{ success: false, error }`
 *   answer (`succeeding`), else the copy.
 */
export type ErrorToast = string | true | { reasonOr: string };

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

/**
 * The app's mutation hooks: pages import them from here, not from
 * @tanstack/react-query (a lint rule holds that), so every write goes
 * through the policy above. The build keeps their query-core modules in a
 * chunk of their own (`rendererChunkGroups`), which the notch never loads.
 */
// oxlint-disable-next-line no-restricted-imports -- the one place they come from
export { useMutation, useMutationState } from "@tanstack/react-query";

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

/** A procedure's `{ success: false }` answer, as a mutation's error. */
class FailedAnswer extends Error {
  constructor(readonly reason: string | undefined) {
    super(reason ?? i18n.t("phase5.failed"));
  }
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
  if (typeof toast === "string") return i18n.t(toast);
  return error instanceof FailedAnswer && error.reason
    ? error.reason
    : i18n.t(toast.reasonOr);
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

/**
 * How long a pending patch may stay applied. The browser fails a write
 * that never reached the host after its write deadline; a port has none,
 * so a call that never settles would otherwise pin its patch for good.
 */
export const PATCH_LIMIT_MS = 60_000;

interface Patch<Data> {
  id: number;
  apply: (data: Data) => Data;
  /** Drops the patch at PATCH_LIMIT_MS; cleared when the write settles. */
  timer: ReturnType<typeof setTimeout>;
}

/** The writes still pending over one cached query, and what they apply. */
interface Pending<Data> {
  /** The value without them: the last fetched or written outside them. */
  baseline: Data | undefined;
  patches: Array<Patch<Data>>;
  /** Writes not yet settled; the key refetches when it reaches 0. */
  open: number;
  /** True while `show` itself writes the cache. */
  writing: boolean;
  stop: () => void;
}

const pendingByClient = new WeakMap<
  QueryClient,
  Map<string, Pending<unknown>>
>();
let nextPatch = 0;
/** Patches dropped at the limit, whose write may still settle later. */
const expired = new Set<number>();

const existing = <Data>(
  client: QueryClient,
  queryKey: QueryKey
): Pending<Data> | undefined =>
  pendingByClient.get(client)?.get(hashKey(queryKey)) as
    | Pending<Data>
    | undefined;

const pendingFor = <Data>(
  client: QueryClient,
  queryKey: QueryKey
): Pending<Data> => {
  let byKey = pendingByClient.get(client);
  if (!byKey) pendingByClient.set(client, (byKey = new Map()));
  const hash = hashKey(queryKey);
  const found = byKey.get(hash) as Pending<Data> | undefined;
  if (found) return found;
  const entry: Pending<Data> = {
    baseline: client.getQueryData<Data>(queryKey),
    patches: [],
    open: 0,
    writing: false,
    // Data landing meanwhile (a reconnect or notice refetch, or a whole
    // answer a notice writes into the cache) is the new baseline; the
    // pending writes stay applied on top of it.
    stop: client.getQueryCache().subscribe((event) => {
      if (
        entry.writing ||
        event.type !== "updated" ||
        event.query.queryHash !== hash ||
        event.action.type !== "success"
      )
        return;
      entry.baseline = event.query.state.data as Data;
      show(client, queryKey, entry);
    }),
  };
  byKey.set(hash, entry as unknown as Pending<unknown>);
  return entry;
};

/** Writes the baseline with every pending patch, in order, into the cache. */
const show = <Data>(
  client: QueryClient,
  queryKey: QueryKey,
  entry: Pending<Data>
): void => {
  const { baseline } = entry;
  if (baseline === undefined) return;
  entry.writing = true;
  try {
    client.setQueryData<Data>(
      queryKey,
      entry.patches.reduce<Data>((data, patch) => patch.apply(data), baseline)
    );
  } finally {
    entry.writing = false;
  }
};

/** One write over the key is done: at the last, drop the entry and refetch. */
const close = async (
  client: QueryClient,
  queryKey: QueryKey,
  entry: Pending<unknown>
): Promise<void> => {
  entry.open -= 1;
  if (entry.open > 0) return;
  // A succeeded patch stays applied until this refetch replaces it.
  for (const patch of entry.patches) clearTimeout(patch.timer);
  entry.stop();
  pendingByClient.get(client)?.delete(hashKey(queryKey));
  await client.invalidateQueries({ queryKey, exact: true });
};

/**
 * The optimistic half of `mutationOptions` for one cached query. Per key,
 * a baseline and the ordered patches of the writes still pending:
 * - before a call goes out, the key's fetch is cancelled and its patch is
 *   applied over the others;
 * - a failure removes only its own patch and re-applies the rest, so it
 *   cannot undo another pending write or bring back a failed one;
 * - data fetched meanwhile becomes the baseline, under the pending patches;
 * - when the last write over the key settles (a count, not `isMutating`,
 *   which writes settling together all read as still pending), the key
 *   refetches once;
 * - a write still unsettled after PATCH_LIMIT_MS loses its patch, and
 *   counts as settled; its late answer changes nothing.
 *
 * Two rules keep the replay right:
 * - `apply` sets values from `variables` (`{ ...data, [id]: enabled }`),
 *   never toggles what it finds: patches are re-applied over every new
 *   baseline.
 * - Anything else writing this key while writes are pending writes a whole
 *   server answer (a value, not a functional updater over the cached
 *   value): what it writes becomes the baseline, so a value derived from
 *   the patched cache would fold the pending patches into it.
 */
export const optimistic = <Data, Variables>(
  queryKey: DataTag<QueryKey, Data, unknown>,
  apply: (data: Data, variables: Variables) => Data
) => ({
  onMutate: async (
    variables: Variables,
    { client }: MutationFunctionContext
  ): Promise<{ patch: number }> => {
    const entry = pendingFor<Data>(client, queryKey);
    entry.open += 1;
    await client.cancelQueries({ queryKey, exact: true });
    // The cancelled fetch left the value it had; it is the baseline.
    if (entry.patches.length === 0)
      entry.baseline = client.getQueryData<Data>(queryKey);
    const id = nextPatch++;
    entry.patches.push({
      id,
      apply: (data) => apply(data, variables),
      timer: setTimeout(() => {
        expired.add(id);
        entry.patches = entry.patches.filter((patch) => patch.id !== id);
        show(client, queryKey, entry);
        void close(client, queryKey, entry as Pending<unknown>);
      }, PATCH_LIMIT_MS),
    });
    show(client, queryKey, entry);
    return { patch: id };
  },
  onError: (
    _error: unknown,
    _variables: Variables,
    result: { patch: number } | undefined,
    { client }: MutationFunctionContext
  ): void => {
    const entry = existing<Data>(client, queryKey);
    if (!entry || result === undefined || expired.has(result.patch)) return;
    entry.patches = entry.patches.filter((patch) => {
      if (patch.id !== result.patch) return true;
      clearTimeout(patch.timer);
      return false;
    });
    show(client, queryKey, entry);
  },
  onSettled: async (
    _data: unknown,
    _error: unknown,
    _variables: Variables,
    result: { patch: number } | undefined,
    { client }: MutationFunctionContext
  ): Promise<void> => {
    if (result !== undefined && expired.delete(result.patch)) return;
    const entry = existing<Data>(client, queryKey);
    if (!entry) return;
    clearTimeout(
      entry.patches.find((patch) => patch.id === result?.patch)?.timer
    );
    await close(client, queryKey, entry as Pending<unknown>);
  },
});

/**
 * For a procedure that answers `{ success: false, error }` instead of
 * throwing: the mutation fails (its message is main's reason, or the
 * generic copy), so the cache's error policy and `onError` see it, and
 * `meta.invalidates` runs only on a real success. A `cancelled` answer (a
 * dialog the user closed) is not a failure. Which text a toast shows is
 * still the site's `errorToast`.
 */
export const succeeding = <
  Options extends {
    mutationFn?: (
      variables: never,
      context: MutationFunctionContext
    ) => Promise<{ success: boolean; error?: string; cancelled?: boolean }>;
  },
>(
  options: Options
): Options => ({
  ...options,
  mutationFn: async (variables: never, context: MutationFunctionContext) => {
    const result = await options.mutationFn!(variables, context);
    if (!result.success && !result.cancelled)
      throw new FailedAnswer(result.error);
    return result;
  },
});
