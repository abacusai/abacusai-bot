/**
 * The chat-app messages this chat asked the bot to send while the computer
 * was offline: each waits in the outbox and goes once, by itself, when the
 * connection is back (Cancel takes it back). One that failed midway says it
 * may not have gone. Gone from here once sent.
 */
import type {
  MessagingSnapshot,
  QueuedChatSend,
} from "@abacus-ai/contract/messaging";
import { messagingPlatformSpec } from "@abacus-ai/contract/messaging";
import { useQueryClient } from "@tanstack/react-query";
import { CircleHelp, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useQueuedSends } from "#renderer/components/connectivity";
import { useMutation } from "#renderer/data/query-client";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

import { useChatView } from "./context";

export const QueuedSendsRow = () => {
  const { threadId } = useChatView();
  const sends = useQueuedSends().filter((send) => send.threadId === threadId);
  if (sends.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-slot="queued-sends">
      {sends.map((send) => (
        <QueuedSendCard key={send.id} send={send} />
      ))}
    </div>
  );
};

export const QueuedSendCard = ({ send }: { send: QueuedChatSend }) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const cancel = useMutation(
    transport.orpc.messaging.cancelQueued.mutationOptions({
      meta: { errorToast: true },
      onSuccess: (snapshot: MessagingSnapshot) =>
        cache.setQueryData(
          transport.orpc.messaging.snapshot.queryKey({ input: {} }),
          snapshot
        ),
    })
  );
  const spec = messagingPlatformSpec(send.platform);
  const app = t(`messaging.platforms.${spec?.nameKey ?? send.platform}`);
  const unsure = send.status === "unsure";
  return (
    <div
      data-slot="queued-send"
      data-status={send.status}
      className="bg-background my-1 flex w-full max-w-[520px] gap-3 rounded-xl border p-3.5 text-sm shadow-xs"
    >
      <span
        aria-hidden
        className={
          unsure
            ? "bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-[9px]"
            : "flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
        }
      >
        {unsure ? (
          <CircleHelp className="size-4" />
        ) : (
          <WifiOff className="size-4" />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="font-semibold">
            {t(
              unsure
                ? "connectivity.queued.unsureTitle"
                : "connectivity.queued.title"
            )}
          </p>
          <p className="text-muted-foreground break-words">
            {t(
              unsure
                ? "connectivity.queued.unsureLine"
                : "connectivity.queued.line",
              {
                text: send.text,
                to: send.to,
                app,
              }
            )}
          </p>
        </div>
        <div>
          <Button
            size="sm"
            variant="outline"
            data-action={unsure ? "dismiss" : "cancel"}
            disabled={cancel.isPending}
            onClick={() => cancel.mutate({ id: send.id })}
          >
            {t(
              unsure
                ? "connectivity.queued.dismiss"
                : "connectivity.queued.cancel"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
};
