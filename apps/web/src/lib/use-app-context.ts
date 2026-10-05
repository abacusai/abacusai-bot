import type { SystemInfo } from "@abacus-ai/contract/contract";
import { ORPCError } from "@orpc/client";
import type { QueryKey } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";

import type { RouterContext } from "#renderer/router";
export const useAppContext = (): RouterContext =>
  useRouter().options.context as RouterContext;
/**
 * The host's system facts. On the web a placeholder until the host answers
 * `system.info` (spec 09 D12); the component re-renders then.
 */
export const useSystem = (): SystemInfo =>
  useSelector(useAppContext().system, (system) => system);
export const foldSearch = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();
export const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const rpcError = (
  error: unknown
): {
  code: string;
  data: { field?: string; detail?: string; reason?: string };
} | null =>
  error instanceof ORPCError && error.defined
    ? {
        code: error.code,
        data: (error.data ?? {}) as {
          field?: string;
          detail?: string;
          reason?: string;
        },
      }
    : null;

/**
 * A toggle that is not a DB row (spec 09 D7), with useMutation's optimistic
 * lifecycle: before the call goes out, `apply` writes the new value into
 * the one query it changes (after cancelling that query's fetch); a
 * failure puts the previous value back and reports; either way the key is
 * refetched once the call settles. It does not call useMutation, and it
 * lives here, beside the context every settings and library page already
 * reads: a module of its own, or query-core's mutation modules, shared by
 * those lazy pages would each split into an extra Electron chunk.
 */
export const useOptimisticToggle = <Data, Variables>(options: {
  queryKey: QueryKey;
  mutationFn: (variables: Variables) => Promise<unknown>;
  apply: (data: Data, variables: Variables) => Data;
  onError: (error: unknown) => void;
}) => {
  const { queryClient } = useAppContext();
  return {
    mutate: (variables: Variables): void => {
      const { queryKey } = options;
      void queryClient.cancelQueries({ queryKey, exact: true });
      const previous = queryClient.getQueryData<Data>(queryKey);
      if (previous !== undefined)
        queryClient.setQueryData<Data>(
          queryKey,
          options.apply(previous, variables)
        );
      void options
        .mutationFn(variables)
        .catch((error: unknown) => {
          if (previous !== undefined)
            queryClient.setQueryData(queryKey, previous);
          options.onError(error);
        })
        .finally(
          () => void queryClient.invalidateQueries({ queryKey, exact: true })
        );
    },
  };
};
