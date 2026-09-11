// Routines live in main; the renderer follows `cronjobs-updated`, since fires
// come from a scheduler and webhooks it cannot see.
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect } from "react";

import type { RoutineRunItem } from "#shared/contracts";
import type {
  Routine,
  RoutineCreateInput,
  RoutineListItem,
  RoutineUpdateInput,
} from "#shared/routines";

import { workspaceQueryKeys } from "../lib/query-keys";

export const useRoutinesQuery = (): UseQueryResult<RoutineListItem[]> => {
  return useQuery({
    queryKey: workspaceQueryKeys.routines,
    queryFn: () => window.api.agent.listRoutines(),
    staleTime: 5_000,
    placeholderData: (prev) => prev,
  });
};

// Polled while looked at: a run settles on main's clock and no event says so.
export const useRoutineRunsQuery = (
  routineId: string | null
): UseQueryResult<RoutineRunItem[]> => {
  return useQuery({
    queryKey: workspaceQueryKeys.routineRuns(routineId ?? ""),
    queryFn: () =>
      routineId == null
        ? Promise.resolve([])
        : window.api.agent.listRoutineRuns(routineId),
    enabled: routineId != null,
    refetchInterval: 4_000,
    placeholderData: (prev) => prev,
  });
};

export const useRoutinesEventSync = (): void => {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unsubscribe = window.api?.agent?.onEvent?.((event) => {
      if (event.type === "cronjobs-updated") {
        void queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.routines,
        });
      }
      // A fire minted a session; the run lists should show it at once.
      if (
        event.type === "cronjobs-updated" ||
        event.type === "local-cli-session-created"
      ) {
        void queryClient.invalidateQueries({
          queryKey: ["local-code", "routines", "runs"],
        });
      }
    });
    return () => unsubscribe?.();
  }, [queryClient]);
};

const useRoutinesInvalidation = (): (() => void) => {
  const queryClient = useQueryClient();
  return () =>
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.routines,
    });
};

export const useCreateRoutineMutation = (): UseMutationResult<
  Routine,
  Error,
  RoutineCreateInput
> => {
  const invalidate = useRoutinesInvalidation();
  return useMutation({
    mutationFn: (input) => window.api.agent.createRoutine(input),
    onSuccess: invalidate,
  });
};

export const useUpdateRoutineMutation = (): UseMutationResult<
  Routine,
  Error,
  { id: string; changes: RoutineUpdateInput }
> => {
  const invalidate = useRoutinesInvalidation();
  return useMutation({
    mutationFn: ({ id, changes }) =>
      window.api.agent.updateRoutine(id, changes),
    onSuccess: invalidate,
  });
};

export const useRemoveRoutineMutation = (): UseMutationResult<
  void,
  Error,
  string
> => {
  const invalidate = useRoutinesInvalidation();
  return useMutation({
    mutationFn: (id) => window.api.agent.removeRoutine(id),
    onSuccess: invalidate,
  });
};

export const useRunRoutineMutation = (): UseMutationResult<
  void,
  Error,
  string | { id: string; trigger: "manual" | "create" }
> => {
  const invalidate = useRoutinesInvalidation();
  return useMutation({
    mutationFn: (input) =>
      typeof input === "string"
        ? window.api.agent.runRoutine(input)
        : window.api.agent.runRoutine(input.id, input.trigger),
    onSuccess: invalidate,
  });
};
