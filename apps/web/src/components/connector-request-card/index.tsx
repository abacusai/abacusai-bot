/**
 * "Connect Slack", asked by the agent, answered in the chat (spec 03 §11.4,
 * port of the old `components/chat/connector-request-card.tsx`). Nothing
 * waits on it: the agent was answered with a link and carries on, and is
 * told once the connector connects. Presentational:
 * the caller runs the flow and answers. A connector whose registry entry
 * takes fields (a token) shows them inline; Connect submits them.
 *
 * Decline is never disabled: mid browser hop it becomes "Stop connecting",
 * which cancels the hop (its cancelled result answers "declined").
 */
import {
  connectFields,
  connectorById,
  connectUi,
} from "@abacus-ai/connectors/registry";
import type { ConnectorRequest } from "@abacus-ai/contract/contracts";
import { Link2, Plug } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Spinner } from "#renderer/components/spinner";
import { cn } from "#renderer/lib/cn";
import { Button } from "#renderer/ui/button";
import { Input } from "#renderer/ui/input";

export interface ConnectorRequestCardProps {
  request: ConnectorRequest;
  busy: boolean;
  error: string | null;
  onConnect(values?: Record<string, string>): void;
  onDecline(): void;
  /** Mid browser hop: cancel the flow. */
  onStop?(): void;
}

export const ConnectorRequestCard = ({
  request,
  busy,
  error,
  onConnect,
  onDecline,
  onStop,
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
  const hopsToBrowser = ui === "browser-hop";
  const provider = request.label;
  const fieldsReady = fields.every(
    ([key]) => (values[key] ?? "").trim() !== ""
  );

  return (
    <div
      className="bg-card/60 mx-auto mb-2 flex w-full max-w-(--composer-max-w) items-start gap-3 rounded-xl border px-3.5 py-3"
      data-slot="connector-request"
      data-connector={request.connectorId}
      role="group"
      aria-labelledby={`${id}-title`}
    >
      <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
        <Plug aria-hidden className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div id={`${id}-title`} className="text-sm font-medium">
          {t("bots.chat.connector.title", { provider })}
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {request.reason ?? t("bots.chat.connector.body", { provider })}
        </p>
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
            {error}
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
          onClick={() => onConnect(fields.length > 0 ? values : undefined)}
        >
          {busy ? <Spinner aria-hidden /> : <Link2 aria-hidden />}
          {busy && hopsToBrowser
            ? t("bots.chat.connector.connecting")
            : t("bots.chat.connector.connect", { provider })}
        </Button>
      </div>
    </div>
  );
};
