/**
 * "Connect Slack", asked by the agent, answered in the chat (spec 03 §11.4,
 * port of the old `components/chat/connector-request-card.tsx`). Nothing
 * waits on it: the agent was answered with a link and carries on, and is
 * told once the connector connects. Presentational:
 * the caller runs the flow and answers. A connector whose registry entry
 * takes fields (a token) shows them inline; Connect submits them.
 *
 * Decline is never disabled: while the connect page is open it becomes
 * "Stop connecting", which stops waiting (answered "declined").
 *
 * A card from a link shows how long the link works; once it expired the card
 * stays and Connect becomes "Get a new link", the same flow with a fresh link.
 */
import {
  connectFields,
  connectorById,
  connectUi,
} from "@abacus-ai/connectors/registry";
import type { ConnectorRequest } from "@abacus-ai/contract/contracts";
import { Link2, Plug, RefreshCw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { useBotNumberConnect } from "#platform/whatsapp-bot";
import { ConnectorMark } from "#renderer/components/connector-mark";
import { Spinner } from "#renderer/components/spinner";
import { cn } from "#renderer/lib/cn";
import { connectErrorText } from "#renderer/lib/connect-page";
import { Button } from "#renderer/ui/button";
import { Input } from "#renderer/ui/input";

/** The clock a live link's countdown reads, a few seconds fresh; idle without one. */
const useLinkClock = (expiresAt: number | undefined): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt == null) return;
    const tick = () => setNow(Date.now());
    // At once for a new expiry (a renewed link), then every few seconds.
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 5_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [expiresAt]);
  return now;
};

export interface ConnectorRequestCardProps {
  request: ConnectorRequest;
  busy: boolean;
  error: string | null;
  onConnect(values?: Record<string, string>): void;
  onDecline(): void;
  /** Connected outside `onConnect` (the web's WhatsApp link): answer the ask. */
  onConnected?(): void;
  /** While the connect page is open: stop waiting. */
  onStop?(): void;
  className?: string;
}

export const ConnectorRequestCard = ({
  request,
  busy,
  error,
  onConnect,
  onDecline,
  onConnected,
  onStop,
  className,
}: ConnectorRequestCardProps) => {
  const { t } = useTranslation();
  const id = useId();
  const connector = connectorById(request.connectorId);
  const ui = connector == null ? "none" : connectUi(connector);
  const fields =
    ui === "fields" && connector != null
      ? Object.entries(connectFields(connector))
      : [];
  const [values, setValues] = useState<Record<string, string>>({});
  // A chat app connects in its own dialog: AbacusAI Bot's number on the web, the desktop's pairing (QR) in the app.
  const botNumber = useBotNumberConnect(onConnected, request.connectorId);
  const hopsToBrowser = ui === "browser-hop";
  const provider = request.label;
  const fieldsReady = fields.every(
    ([key]) => (values[key] ?? "").trim() !== ""
  );
  const now = useLinkClock(
    request.expired === true ? undefined : request.expiresAt
  );
  const left = request.expiresAt != null ? request.expiresAt - now : null;
  const expired = request.expired === true || (left != null && left <= 0);

  return (
    <div
      className={cn(
        "bg-card/60 mx-auto mb-2 flex w-full max-w-(--composer-max-w) items-start gap-3 rounded-xl border px-3.5 py-3",
        className
      )}
      data-slot="connector-request"
      data-connector={request.connectorId}
      role="group"
      aria-labelledby={`${id}-title`}
    >
      {connector ? (
        <ConnectorMark
          id={connector.logo ?? connector.id}
          initial={connector.name.slice(0, 1)}
          size={36}
        />
      ) : (
        <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
          <Plug aria-hidden className="size-4" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div id={`${id}-title`} className="text-sm font-medium">
          {t("bots.chat.connector.title", { provider })}
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {request.reason ?? t("bots.chat.connector.body", { provider })}
        </p>
        {expired ? (
          <p
            className="mt-0.5 text-xs text-amber-700 dark:text-amber-400"
            data-slot="connector-request-expiry"
          >
            {t("bots.chat.connector.expired")}
          </p>
        ) : (
          left != null && (
            <p
              className="text-muted-foreground mt-0.5 text-xs"
              data-slot="connector-request-expiry"
            >
              {t("bots.chat.connector.worksFor", {
                count: Math.ceil(left / 60_000),
              })}
            </p>
          )
        )}
        {fields.length > 0 && (
          <div className="mt-2 flex flex-col gap-2">
            {fields.map(([key, field]) => (
              <label key={key} className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">{field.label}</span>
                <Input
                  type={field.secret === true ? "password" : "text"}
                  placeholder={field.placeholder}
                  value={values[key] ?? ""}
                  disabled={busy}
                  autoComplete="off"
                  onChange={(event) =>
                    setValues((previous) => ({
                      ...previous,
                      [key]: event.target.value,
                    }))
                  }
                />
              </label>
            ))}
          </div>
        )}
        {error != null && (
          <p
            className="text-destructive mt-1 text-xs"
            role="alert"
            data-slot="connector-request-error"
          >
            {connectErrorText(t, error)}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          data-slot="connector-request-decline"
          onClick={() => {
            if (busy && hopsToBrowser) onStop?.();
            else if (!busy) onDecline();
          }}
        >
          {busy && hopsToBrowser
            ? t("bots.chat.connector.stop")
            : t("bots.chat.connector.decline")}
        </Button>
        <Button
          size="sm"
          data-slot="connector-request-connect"
          disabled={busy || !fieldsReady}
          className={cn(
            busy && hopsToBrowser && "h-auto py-1.5 whitespace-normal"
          )}
          onClick={() =>
            botNumber
              ? botNumber.connect()
              : onConnect(fields.length > 0 ? values : undefined)
          }
        >
          {busy ? (
            <Spinner aria-hidden />
          ) : expired ? (
            <RefreshCw aria-hidden />
          ) : (
            <Link2 aria-hidden />
          )}
          {busy && hopsToBrowser
            ? t("bots.chat.connector.connecting")
            : expired
              ? t("bots.chat.connector.renew")
              : t("bots.chat.connector.connect", { provider })}
        </Button>
      </div>
      {botNumber?.dialog}
    </div>
  );
};
