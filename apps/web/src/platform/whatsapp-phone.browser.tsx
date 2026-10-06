import { useQuery, useQueryClient } from "@tanstack/react-query";

import { WebMessagingPage as Page } from "#renderer/features/library/whatsapp-phone";
import {
  unlinkWhatsAppChat,
  whatsappChatQuery,
  WhatsAppConnect,
} from "#renderer/features/onboarding/whatsapp";
import { callApps } from "#renderer/features/shell/connect/services";

/** AbacusAI Bot's own number where the server offers it; "Message yourself" otherwise. */
export const WebMessagingPage = () => {
  const cache = useQueryClient();
  const chat = useQuery(whatsappChatQuery(callApps));
  if (chat.isPending) return null;
  return (
    <Page
      callApps={callApps}
      bot={
        chat.data?.available
          ? {
              linked: chat.data.status === "linked",
              phone: chat.data.phone ?? null,
              number: chat.data.number ?? null,
              unlink: () => unlinkWhatsAppChat(cache, callApps),
              connect: (done) => (
                <WhatsAppConnect callApps={callApps} onLinked={done} />
              ),
            }
          : undefined
      }
    />
  );
};
