import { useEffect } from "react";

import i18n from "../i18n";

/**
 * OS notifications for permission requests and turn completions whenever the
 * window is unfocused. Mounted at the App root so the subscription outlives
 * every view, including while the window is hidden.
 */

export const useNotifications = (): void => {
  useEffect(() => {
    // True when the window isn't focused — notify only if the user can't see it.
    const shouldNotify = (): boolean => !document.hasFocus();

    const unsubscribe = window.api.agent.onEvent((event) => {
      // Same NDJSON channel the transcript reads, so this cannot drift from it.
      if (event.type !== "local-cli-ndjson") return;
      if (
        event.workspaceId == null ||
        event.sessionId == null ||
        event.payload == null
      )
        return;

      const { workspaceId, sessionId } = event;
      const message = event.payload as {
        type?: string;
        request?: { tool?: { name?: string } };
        event?: { type?: string };
      };

      if (message.type === "permission_needed" && shouldNotify()) {
        const toolName =
          message.request?.tool?.name || i18n.t("notifications.toolFallback");
        void window.api.showNotification(
          i18n.t("notifications.permissionRequired"),
          i18n.t("notifications.waitingForApproval", { toolName }),
          { workspaceId, sessionId }
        );
        return;
      }

      if (
        message.type === "event" &&
        message.event?.type === "turn_complete" &&
        shouldNotify()
      ) {
        void window.api.showNotification(
          i18n.t("notifications.taskCompleted"),
          i18n.t("notifications.codeSessionFallback"),
          { workspaceId, sessionId }
        );
      }
    });

    return unsubscribe;
  }, []);
};
