/**
 * A chat-app agent (WhatsApp, Telegram, Discord) is used from that app on the
 * phone. Until the app is connected, its chat here leads with the Connect
 * card, from the moment the chat opens and whatever the agent says; the card
 * goes once the app connects. The agent's own connect asks still show below.
 */
import type { BotRow } from "@abacus-ai/contract/contract/rows";
import type { ConversationKey } from "@abacus-ai/contract/conversation-scope";
import {
  isMessagingPlatformConnected,
  type MessagingPlatformId,
} from "@abacus-ai/contract/messaging";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ConnectorRequestCard } from "#renderer/components/connector-request-card";
import type { Transport } from "#renderer/data/transport";
import { ConnectAttempt } from "#renderer/lib/connect-page";
import { IS_ELECTRON } from "#renderer/lib/platform";

/** The connector a chat app connects through (the registry's `messaging-<platform>`). */
export const homeChannelConnectorId = (channel: MessagingPlatformId): string =>
  `messaging-${channel}`;

export const HomeChannelConnect = ({
  bot,
  transport,
  conversationKey,
}: {
  bot: BotRow;
  transport: Transport;
  conversationKey: ConversationKey | null;
}) => {
  const { t } = useTranslation();
  const cache = useQueryClient();
  // The desktop pairs the chat apps; the web build has its own WhatsApp path.
  const channel = IS_ELECTRON ? (bot.homeChannel ?? null) : null;
  const snapshot = useQuery({
    ...transport.orpc.messaging.snapshot.queryOptions({ input: {} }),
    enabled: channel != null,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notNow, setNotNow] = useState(false);
  const attempt = useRef<ConnectAttempt | null>(null);
  if (
    channel == null ||
    conversationKey == null ||
    snapshot.data == null ||
    notNow ||
    isMessagingPlatformConnected(snapshot.data, channel)
  )
    return null;
  const connectorId = homeChannelConnectorId(channel);
  const provider = t(`messaging.platforms.${channel}`);
  const refresh = () =>
    void cache.invalidateQueries({
      queryKey: transport.orpc.messaging.snapshot.queryKey({ input: {} }),
    });
  const connect = (values?: Record<string, string>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // Fields (a bot token) are submitted; anything else runs the connect flow.
    const current =
      values == null ? new ConnectAttempt(transport, connectorId) : null;
    attempt.current = current;
    const outcome =
      current?.result ??
      transport.client.connectors.submitFields({
        connectorId,
        values: values ?? {},
      });
    void outcome
      .then((result) => {
        if (attempt.current !== current) return;
        attempt.current = null;
        setBusy(false);
        if (!result.ok && result.cancelled !== true) setError(result.error);
        refresh();
      })
      .catch((reason: unknown) => {
        attempt.current = null;
        setBusy(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };
  return (
    <ConnectorRequestCard
      request={{
        requestId: `home-channel:${bot.id}`,
        connectorId,
        label: provider,
        reason: t("bots.chat.connector.homeChannel", { provider }),
        conversationKey,
      }}
      busy={busy}
      error={error}
      onConnect={connect}
      onConnected={refresh}
      onDecline={() => setNotNow(true)}
      onStop={() => {
        attempt.current?.cancel();
        attempt.current = null;
        setBusy(false);
      }}
    />
  );
};
