// Bots live in main; the renderer follows `bots-updated` rather than polling.
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import type {
  Bot,
  BotChatHandle,
  BotCreateInput,
  BotUpdateInput,
} from "#shared/bots";
import type { BotChatPreview, BotSenderChat } from "#shared/contracts";

import { workspaceQueryKeys } from "../lib/query-keys";

export const useBotsQuery = (): UseQueryResult<Bot[]> => {
  return useQuery({
    queryKey: workspaceQueryKeys.bots,
    queryFn: () => window.api.agent.listBots(),
    staleTime: 5_000,
    placeholderData: (prev) => prev,
  });
};

// Separate from the bots list because it changes every turn, not on edit.
export const useBotChatPreviewsQuery = (): UseQueryResult<
  Record<string, BotChatPreview>
> => {
  return useQuery({
    queryKey: workspaceQueryKeys.botChatPreviews,
    queryFn: () => window.api.agent.listBotChatPreviews(),
    staleTime: 5_000,
    placeholderData: (prev) => prev,
  });
};

export const useBotSenderChatsQuery = (): UseQueryResult<BotSenderChat[]> => {
  return useQuery({
    queryKey: workspaceQueryKeys.botSenderChats,
    queryFn: () => window.api.agent.listBotSenderChats(),
    staleTime: 5_000,
    placeholderData: (prev) => prev,
  });
};

// Sessions the Sessions list must not repeat. Sender chats are filed under the
// bot, not on `bot.sessionId`, so that field alone lists them twice.
export const useBotOwnedSessionIds = (): ReadonlySet<string> => {
  const bots = useBotsQuery().data;
  const senderChats = useBotSenderChatsQuery().data;
  return useMemo(
    () =>
      new Set([
        ...(bots ?? [])
          .map((bot) => bot.sessionId)
          .filter((id): id is string => id != null),
        ...(senderChats ?? []).map((chat) => chat.sessionId),
      ]),
    [bots, senderChats]
  );
};

export const useBotsEventSync = (): void => {
  const queryClient = useQueryClient();

  useEffect(() => {
    const unsubscribe = window.api?.agent?.onEvent?.((event) => {
      if (event.type === "bots-updated") {
        void queryClient.invalidateQueries({
          queryKey: workspaceQueryKeys.bots,
        });
      }
    });
    return () => unsubscribe?.();
  }, [queryClient]);
};

export const useCreateBotMutation = (): UseMutationResult<
  Bot,
  Error,
  BotCreateInput
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: BotCreateInput) => window.api.agent.createBot(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.bots });
    },
  });
};

export const useUpdateBotMutation = (): UseMutationResult<
  Bot,
  Error,
  { id: string; changes: BotUpdateInput }
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, changes }) => window.api.agent.updateBot(id, changes),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.bots });
    },
  });
};

export const useDeleteBotMutation = (): UseMutationResult<
  void,
  Error,
  string
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => window.api.agent.deleteBot(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.bots });
      // Opening or deleting a bot mints/removes sessions.
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.agentSessionsRoot,
      });
    },
  });
};

export const useOpenBotChatMutation = (): UseMutationResult<
  BotChatHandle,
  Error,
  string
> => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (botId: string) => window.api.agent.openBotChat(botId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.bots });
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.agentSessionsRoot,
      });
    },
  });
};
