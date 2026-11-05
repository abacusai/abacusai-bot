import {
  connectorById,
  connectorForPlatform,
  type MessagingConnector,
} from "@abacus-ai/connectors/registry";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { MessagingPlatformDialog } from "#renderer/features/library/messaging";
import { useAppContext } from "#renderer/lib/use-app-context";

// AbacusAI Bot's own WhatsApp number is a browser feature; the desktop app links WhatsApp itself.
export const WhatsAppIntro = () => null;

/** The pairing dialog for an ask: on close, the ask is answered if the chat app now reads connected. */
const AskPairingDialog = ({
  entry,
  onClosed,
}: {
  entry: MessagingConnector;
  onClosed(connected: boolean): void;
}) => {
  const { transport } = useAppContext();
  const queryClient = useQueryClient();
  return (
    <MessagingPlatformDialog
      key={entry.platform}
      platform={entry.platform}
      onClose={async () => {
        const statuses = await transport.client.connectors.statuses({});
        await queryClient.invalidateQueries({
          queryKey: transport.orpc.connectors.statuses.queryKey({ input: {} }),
        });
        onClosed(statuses[entry.id]?.state === "connected");
      }}
      finalFocus={() =>
        document.querySelector<HTMLElement>(
          '[data-slot="connector-request-connect"]'
        )
      }
    />
  );
};

/**
 * A chat app's Connect in an ask card (WhatsApp, Telegram, Discord): the
 * desktop pairs it in the same dialog as onboarding and the Library, and the
 * ask is answered once the pairing left it connected. Null for any other
 * connector, which the card's own Connect handles.
 */
export const useBotNumberConnect = (
  onConnected: (() => void) | undefined,
  connectorId?: string
): { connect(): void; dialog: ReactNode } | null => {
  const [open, setOpen] = useState(false);
  const entry =
    connectorId == null
      ? undefined
      : (connectorById(connectorId) ?? connectorForPlatform(connectorId));
  if (entry?.kind !== "messaging" || onConnected == null) return null;
  return {
    connect: () => setOpen(true),
    dialog: open ? (
      <AskPairingDialog
        entry={entry}
        onClosed={(connected) => {
          setOpen(false);
          if (connected) onConnected();
        }}
      />
    ) : null,
  };
};
