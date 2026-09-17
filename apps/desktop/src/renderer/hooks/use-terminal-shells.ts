/**
 * The terminal shell roster, shared by the settings row and the terminal
 * panel's `+` menu. One query key, so picking a shell in the panel moves the
 * settings row and the other way round.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  TerminalShellId,
  TerminalShellState,
} from "#shared/terminal-shells";

import { settingsQueryKeys } from "../lib/settings-query-keys";

export const useTerminalShellState = (): TerminalShellState | null => {
  const query = useQuery({
    queryKey: settingsQueryKeys.capabilities.terminalShell,
    queryFn: async () =>
      (await window.api?.agent?.getTerminalShellState?.()) ?? null,
    staleTime: 10_000,
  });

  return query.data ?? null;
};

/**
 * Store a pick. Writing it is the point: the next terminal the panel opens on
 * its own reads the same preference, so the last shell used comes back
 * without anyone being asked again.
 */
export const useSetTerminalShell = (): ((shell: TerminalShellId) => void) => {
  const queryClient = useQueryClient();
  const choose = useMutation({
    mutationFn: async (shell: TerminalShellId) =>
      (await window.api?.agent?.setTerminalShell?.(shell)) ?? null,
    onSuccess: (state) => {
      if (state != null)
        queryClient.setQueryData(
          settingsQueryKeys.capabilities.terminalShell,
          state
        );
    },
  });

  return (shell) => choose.mutate(shell);
};
