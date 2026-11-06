/**
 * What the channels read: the list and one thread, refetched on the
 * host's coarse `channels.events` notices.
 */
import type { ChannelSummary } from "@abacus-ai/contract/channels";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { followNotice } from "#renderer/data/queries/notices";
import type { AppQueryUtils } from "#renderer/data/transport";

import { useBotsTransport } from "../data/transport";

export const channelsQueries = (orpc: AppQueryUtils) => ({
  list: () => orpc.channels.list.queryOptions({ input: {} }),
  thread: (channelId: string) =>
    orpc.channels.thread.queryOptions({ input: { channelId } }),
});

/** Refetch the list and open threads while mounted. */
export const useChannelsLive = (): void => {
  const transport = useBotsTransport();
  const queryClient = useQueryClient();
  useEffect(() => {
    const controller = new AbortController();
    followNotice(
      "channels",
      transport,
      (event) => {
        void queryClient.invalidateQueries({
          queryKey: transport.orpc.channels.list.key(),
        });
        void queryClient.invalidateQueries({
          queryKey:
            event.channelId == null
              ? transport.orpc.channels.thread.key()
              : transport.orpc.channels.thread.key({
                  input: { channelId: event.channelId },
                }),
        });
      },
      controller.signal
    );
    return () => controller.abort();
  }, [transport, queryClient]);
};

const NONE: ChannelSummary[] = [];

export const useChannels = (): ChannelSummary[] => {
  const transport = useBotsTransport();
  return useQuery(channelsQueries(transport.orpc).list()).data ?? NONE;
};

export const useChannelThread = (channelId: string) => {
  const transport = useBotsTransport();
  return useQuery(channelsQueries(transport.orpc).thread(channelId));
};

export { channelTitle as groupTitle } from "@abacus-ai/contract/channels";
