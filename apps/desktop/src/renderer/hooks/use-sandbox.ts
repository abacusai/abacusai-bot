import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { DefaultAgentMode, SandboxSupport } from "#shared/contracts";

import { settingsQueryKeys } from "../lib/settings-query-keys";
import { useWorkspaceStore } from "../stores/code-store";

/**
 * Whether this machine can confine a command. Decides whether Auto is offered
 * anywhere: the mode picker and the Profile page both ask. Probed once by
 * main and never stale, since it cannot change without a relaunch.
 */
export const useSandboxSupportQuery = () =>
  useQuery<SandboxSupport | null>({
    queryKey: settingsQueryKeys.sandbox.support,
    queryFn: async () =>
      (await window.api?.agent?.getSandboxSupport?.()) ?? null,
    staleTime: Infinity,
  });

/** The mode a session, bot or routine starts in when nothing picks one. */
export const useDefaultAgentModeQuery = () =>
  useQuery<DefaultAgentMode | null>({
    queryKey: settingsQueryKeys.sandbox.defaultMode,
    queryFn: async () =>
      (await window.api?.agent?.getDefaultAgentMode?.()) ?? null,
    staleTime: 10_000,
  });

/**
 * Changing the default also moves the picker's sticky mode: the choice is
 * "what my sessions run in", and a picker still on the old mode would spawn
 * the next one in it.
 */
export const useSetDefaultAgentMode = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (mode: DefaultAgentMode) =>
      (await window.api?.agent?.setDefaultAgentMode?.(mode)) ?? mode,
    onSuccess: (stored) => {
      queryClient.setQueryData(settingsQueryKeys.sandbox.defaultMode, stored);
      useWorkspaceStore.getState().setSelectedMode(stored);
    },
  });
};
