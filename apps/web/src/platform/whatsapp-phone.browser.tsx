import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { WebMessagingPage as Page } from "#renderer/features/library/whatsapp-phone";
import {
  unlinkWhatsAppChat,
  whatsappChatQuery,
  WhatsAppConnect,
} from "#renderer/features/onboarding/whatsapp";
import { callApps } from "#renderer/features/shell/connect/services";
import { Button } from "#renderer/ui/button";

/** AbacusAI Bot's own number where the server offers it; "Message yourself" otherwise. */
export const WebMessagingPage = () => {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const chat = useQuery(whatsappChatQuery(callApps));
  if (chat.isPending) return null;
  // Unknown is not "not offered": never fall back to the other flow on a failed call.
  if (chat.isError)
    return (
      <div
        role="alert"
        className="flex flex-col items-center gap-3 p-6 text-center text-sm"
      >
        <p className="text-muted-foreground">{t("phase5.failed")}</p>
        <Button variant="secondary" onClick={() => void chat.refetch()}>
          {t("messaging.sharedLink.retry")}
        </Button>
      </div>
    );
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
