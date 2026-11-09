import type { MessagingRecovery } from "@abacus-ai/contract/messaging";
import type { TFunction } from "i18next";

/** The line for a chat app that has been down a while and is retrying by itself. */
export const recoveryLine = (
  recovery: MessagingRecovery,
  platform: string,
  now: number,
  t: TFunction
): string => {
  if (recovery.stopped) return t("messaging.recovery.stopped", { platform });
  if (recovery.nextTryAt == null)
    return t("messaging.recovery.now", { platform });
  const minutes = Math.max(1, Math.ceil((recovery.nextTryAt - now) / 60_000));
  return t("messaging.recovery.next", { platform, minutes });
};
