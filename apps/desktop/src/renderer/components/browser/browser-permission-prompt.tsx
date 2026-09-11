import { Globe, TabletSmartphone } from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type {
  BrowserPermissionDecision,
  BrowserPermissionRequest,
} from "#shared/contracts";
import {
  conversationRefFromKey,
  type ConversationKey,
} from "#shared/conversation-scope";

import { useActiveConversationKey } from "../../stores/active-conversation-store";
import { useWorkspaceStore } from "../../stores/code-store";
import { Alert, AlertDescription, AlertTitle, Button } from "../ui";

/**
 * The browser and device servers' "may I?", for the conversation on screen
 * only: a grant is a decision about a specific task, and the wrong pane must
 * not be able to make it. A prompt for a conversation not on screen gets that
 * conversation's sidebar dot and is picked back up when it is opened.
 */

/** Flag the conversation a prompt arrived for, when it is not on screen. */
const flagConversation = (conversationKey: ConversationKey): void => {
  const ref = conversationRefFromKey(conversationKey);
  if (ref?.kind === "session")
    useWorkspaceStore.getState().markSessionCompleted(ref.sessionId);
};

export const BrowserPermissionPrompt = (): JSX.Element | null => {
  const { t } = useTranslation();
  const scope = useActiveConversationKey();
  const [queue, setQueue] = useState<BrowserPermissionRequest[]>([]);

  useEffect(() => {
    const off = window.api?.agent?.onEvent?.((event) => {
      if (event.type === "browser-permission-request") {
        if (event.request.conversationKey !== scope) {
          flagConversation(event.request.conversationKey);
          return;
        }
        setQueue((prev) =>
          prev.some((row) => row.requestId === event.request.requestId)
            ? prev
            : [...prev, event.request]
        );
      } else if (event.type === "browser-permission-cleared") {
        setQueue((prev) => prev.filter((r) => r.requestId !== event.requestId));
      }
    });
    // A switch swaps the queue; what the last conversation waited on stays in main.
    setQueue([]);
    if (scope != null) {
      void window.api?.agent
        ?.listBrowserPermissionRequests?.(scope)
        .then((pending) => {
          if (pending == null || pending.length === 0) return;
          setQueue((prev) => [
            ...prev,
            ...pending.filter(
              (row) =>
                row.conversationKey === scope &&
                !prev.some((existing) => existing.requestId === row.requestId)
            ),
          ]);
        });
    }
    return () => off?.();
  }, [scope]);

  const current =
    scope == null
      ? undefined
      : queue.find((row) => row.conversationKey === scope);
  if (current == null) return null;
  const PermissionIcon = current.server === "device" ? TabletSmartphone : Globe;

  const respond = async (
    decision: BrowserPermissionDecision
  ): Promise<void> => {
    setQueue((prev) => prev.filter((r) => r.requestId !== current.requestId));
    await window.api?.agent?.respondBrowserPermission?.({
      requestId: current.requestId,
      conversationKey: current.conversationKey,
      decision,
    });
  };

  return createPortal(
    <Alert
      className="fixed right-4 bottom-4 left-4 z-50 max-w-none grid-cols-[auto_minmax(0,1fr)] gap-x-3 p-4 shadow-xl sm:right-6 sm:bottom-6 sm:left-auto sm:max-w-sm"
      data-id="browser-permission-prompt"
    >
      <div className="bg-primary/10 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
        <PermissionIcon className="text-primary size-3.5" />
      </div>
      <div className="min-w-0">
        <AlertTitle className="text-sm">
          {t(
            current.server === "device"
              ? "devicePermission.title"
              : "browserPermission.title"
          )}
        </AlertTitle>
        <AlertDescription className="mt-0.5 truncate text-xs">
          {current.summary}
        </AlertDescription>
        {/* One-off calls on top, lasting grants below; four buttons on one row
            wrap badly once the labels are translated. */}
        <div className="mt-3 grid grid-cols-2 gap-1.5">
          <Button
            size="sm"
            onClick={() => void respond("allow")}
            data-id="browser-permission-allow"
          >
            {t("browserPermission.allow")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void respond("deny")}
            data-id="browser-permission-deny"
          >
            {t("browserPermission.deny")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void respond("session")}
            data-id="browser-permission-session"
          >
            {t("browserPermission.session")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void respond("always")}
            data-id="browser-permission-always"
          >
            {t("browserPermission.never")}
          </Button>
        </div>
      </div>
    </Alert>,
    document.body
  );
};
