import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect } from "react";

import type { LocalModelInstallOutcome } from "#shared/contracts";
import type { LocalModelState } from "#shared/local-models";

import { settingsQueryKeys } from "../lib/settings-query-keys";

export const localModelsQueryKey = ["settings", "local-models"] as const;

/**
 * What this machine can run locally, kept current: the main process reports
 * download progress as events, and each one is folded into the cached state so
 * every surface showing it (the card, the dialog, the settings section) moves
 * together without polling.
 */
export const useLocalModels = (): {
  state: LocalModelState | undefined;
  query: UseQueryResult<LocalModelState>;
  install: (modelId: string) => Promise<LocalModelInstallOutcome>;
  cancel: () => Promise<void>;
  remove: (modelId: string) => Promise<void>;
} => {
  const queryClient = useQueryClient();
  const query = useQuery<LocalModelState>({
    queryKey: localModelsQueryKey,
    queryFn: () => window.api.agent.getLocalModelState(),
    // A build without the runtime, or a test without the bridge: no state.
    retry: false,
    staleTime: 30_000,
  });

  useEffect(
    () =>
      window.api?.agent?.onEvent?.((event) => {
        if (event.type !== "local-model-progress") return;
        queryClient.setQueryData<LocalModelState>(
          localModelsQueryKey,
          (state) =>
            state == null
              ? state
              : {
                  ...state,
                  download:
                    event.progress.phase === "downloading" ||
                    event.progress.phase === "verifying"
                      ? event.progress
                      : null,
                  installedIds:
                    event.progress.phase === "ready" &&
                    !state.installedIds.includes(event.progress.modelId)
                      ? [...state.installedIds, event.progress.modelId]
                      : state.installedIds,
                }
        );
        // The end of a download is a fresh read's worth of news: what is
        // installed, what is served, and the catalog the picker shows.
        if (
          event.progress.phase !== "downloading" &&
          event.progress.phase !== "verifying"
        ) {
          void queryClient.invalidateQueries({ queryKey: localModelsQueryKey });
          void queryClient.invalidateQueries({
            queryKey: settingsQueryKeys.models.all,
          });
        }
      }),
    [queryClient]
  );

  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: localModelsQueryKey });

  return {
    state: query.data,
    query,
    install: async (modelId) => {
      const outcome = await window.api.agent.installLocalModel(modelId);
      await refresh();
      return outcome;
    },
    cancel: async () => {
      await window.api.agent.cancelLocalModelInstall();
      await refresh();
    },
    remove: async (modelId) => {
      await window.api.agent.removeLocalModel(modelId);
      await refresh();
      await queryClient.invalidateQueries({
        queryKey: settingsQueryKeys.models.all,
      });
    },
  };
};
