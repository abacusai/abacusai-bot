import type { MessagingRecovery } from "@abacus-ai/contract/messaging";
import type { TFunction } from "i18next";

/** The line for a chat app that has been down a while: what the app is doing about it. */
export const recoveryLine = (
  recovery: MessagingRecovery,
  platform: string,
  now: number,
  t: TFunction
): string => {
  switch (recovery.phase) {
    case "trying":
      return t("messaging.recovery.now", { platform });
    case "disk":
      return t("messaging.recovery.disk", { platform });
    case "stopped":
      return t("messaging.recovery.stopped", { platform });
    case "needs_user":
      return t("messaging.recovery.needsUser", { platform });
    case "scheduled": {
      const minutes = Math.max(
        1,
        Math.ceil(((recovery.nextTryAt ?? now) - now) / 60_000)
      );
      return t("messaging.recovery.next", { platform, minutes });
    }
  }
};
