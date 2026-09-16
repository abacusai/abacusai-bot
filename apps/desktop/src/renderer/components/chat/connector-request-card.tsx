import { Link2, Plug } from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { ConnectorRequest } from "#shared/contracts";
import {
  conversationRefFromKey,
  type ConversationKey,
} from "#shared/conversation-scope";

import { connectorById, connectUi } from "../../connectors";
import { cn } from "../../lib/cn";
import { useActiveConversationKey } from "../../stores/active-conversation-store";
import { useWorkspaceStore } from "../../stores/code-store";
import { useConnectFlow } from "../connectors/connect-flow";
import { Button, Spinner } from "../ui";

/**
 * "Connect Slack", asked by the agent, answered in the chat. The agent's turn
 * is suspended inside the tool call while this is up; declining resolves it
 * with a sentence the model can act on. Shown only in the conversation that
 * asked; another conversation's ask gets its sidebar dot until it is opened.
 *
 * Connecting runs the same flow as the Connectors page — a browser hop, the
 * fields dialog, a pairing dialog, whichever the registry says the connector
 * needs — so a token card like GitHub is one click here too.
 */

/** Flag the conversation an ask arrived for, when it is not the one on screen. */
const flagConversation = (conversationKey: ConversationKey): void => {
  const ref = conversationRefFromKey(conversationKey);
  if (ref?.kind === "session")
    useWorkspaceStore.getState().markSessionCompleted(ref.sessionId);
};

export const ConnectorRequestCard = (): JSX.Element | null => {
  const { t } = useTranslation();
  const scope = useActiveConversationKey();
  const [queue, setQueue] = useState<ConnectorRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flow = useConnectFlow();
  const activeWorkspaceId = useWorkspaceStore(
    (state) => state.activeWorkspaceId
  );
  const getActiveSessionId = useWorkspaceStore(
    (state) => state.getActiveSessionId
  );

  useEffect(() => {
    const off = window.api?.agent?.onEvent?.((event) => {
      if (event.type === "connector-request") {
        if (event.request.conversationKey !== scope) {
          flagConversation(event.request.conversationKey);
          return;
        }
        setQueue((prev) =>
          prev.some((request) => request.requestId === event.request.requestId)
            ? prev
            : [...prev, event.request]
        );
      } else if (event.type === "connector-cleared") {
        setQueue((prev) =>
          prev.filter((request) => request.requestId !== event.requestId)
        );
      }
    });
    // The queue is component state and the component unmounts on page change,
    // so pick this conversation's still-pending asks back up from main. Only
    // this conversation's, or another chat's ask lands in here.
    setQueue([]);
    if (scope != null) {
      void window.api?.agent?.listConnectorRequests?.(scope).then((pending) => {
        if (pending == null || pending.length === 0) return;
        setQueue((prev) => [
          ...prev,
          ...pending.filter(
            (request) =>
              request.conversationKey === scope &&
              !prev.some((row) => row.requestId === request.requestId)
          ),
        ]);
      });
    }
    return () => off?.();
  }, [scope]);

  const current =
    scope == null
      ? undefined
      : queue.find((request) => request.conversationKey === scope);
  if (current == null) return null;

  const connector = connectorById(current.connectorId);
  // Only a browser hop leaves the user in another window; the dialogs are
  // right here, so "check your browser" would be wrong for them.
  const hopsToBrowser =
    connector != null && connectUi(connector) === "browser-hop";

  const answer = async (
    outcome: "connected" | "declined" | "failed",
    failure?: string
  ): Promise<void> => {
    setQueue((prev) =>
      prev.filter((request) => request.requestId !== current.requestId)
    );
    setBusy(false);
    setError(null);
    await window.api?.agent?.respondConnector?.({
      requestId: current.requestId,
      conversationKey: current.conversationKey,
      outcome,
      ...(failure != null ? { error: failure } : {}),
    });
  };

  /**
   * Reconnect the running session's MCP servers so the new connector's tools
   * enter its tool list. Awaited before the tool call is resolved: the agent's
   * very next act is a tool call, so a refresh started after the answer is a
   * race it loses.
   */
  const refreshRunningAgent = async (): Promise<void> => {
    if (activeWorkspaceId == null) return;
    const sessionId = getActiveSessionId(activeWorkspaceId);
    // No session running is the ordinary case, not a failure: the next one
    // starts from the file, which is already correct.
    if (sessionId == null) return;
    await window.api?.agent?.refreshMcpServers?.({
      workspaceId: activeWorkspaceId,
      sessionId,
    });
  };

  const connect = async (): Promise<void> => {
    if (connector == null) {
      await answer("failed", `Unknown connector ${current.connectorId}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await flow.start(connector);
      if (result.ok === true) {
        await refreshRunningAgent();
        await answer("connected");
        return;
      }
      // Cancelling is a decision, not a failure — but the agent is still
      // waiting, and it is waiting on an answer either way.
      if (result.cancelled === true) {
        await answer("declined");
        return;
      }
      setError(
        result.error ??
          t("connectorRequest.failed", { provider: current.label })
      );
      setBusy(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <>
      {flow.dialogs}
      <div
        className="border-border bg-card/60 mx-4 mb-2 flex items-start gap-3 rounded-xl border px-3.5 py-3"
        data-id="connector-request"
        data-connector={current.connectorId}
      >
        <span className="bg-primary/10 flex size-9 shrink-0 items-center justify-center rounded-lg">
          <Plug className="text-primary size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="text-foreground text-sm font-medium">
            {t("connectorRequest.title", { provider: current.label })}
          </div>
          <p className="text-secondary-foreground mt-0.5 text-xs">
            {current.reason ??
              t("connectorRequest.body", { provider: current.label })}
          </p>
          {error != null && (
            <p
              className="text-destructive mt-1 text-xs"
              data-id="connector-request-error"
            >
              {error}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Never disabled: a user who clicked Connect and changed their
              mind in the browser used to come back to a card that was all
              spinner — the agent suspended in the tool call, no way out until
              the timeout. Mid-hop, declining cancels the browser wait, whose
              resolution (cancelled) answers the agent "declined"; answering
              here too would answer twice. */}
          <Button
            variant="link"
            size="sm"
            data-id="connector-request-decline"
            onClick={() => {
              if (busy && hopsToBrowser) flow.cancel();
              else if (!busy) void answer("declined");
            }}
            className="text-muted-foreground hover:text-secondary-foreground text-xs"
          >
            {busy ? t("connectorRequest.stop") : t("connectorRequest.decline")}
          </Button>
          <Button
            size="sm"
            data-id="connector-request-connect"
            disabled={busy}
            onClick={() => void connect()}
            className={cn(
              busy &&
                hopsToBrowser &&
                "h-auto py-1.5 text-left whitespace-normal"
            )}
          >
            {busy ? <Spinner fontSize={12} /> : <Link2 className="size-3.5" />}
            {busy && hopsToBrowser
              ? t("connectorRequest.connecting")
              : t("connectorRequest.connect", { provider: current.label })}
          </Button>
        </div>
      </div>
    </>
  );
};
