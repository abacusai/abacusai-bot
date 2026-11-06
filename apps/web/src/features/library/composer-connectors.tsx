/**
 * The composer's + menu, Add connectors: the same list and connect flow as
 * the Connectors page, without leaving the chat. Connected rows only show
 * it; managing one stays on the page. Chat apps pair on their own page.
 */
import { Check, Settings } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";

import { ConnectorMark } from "#renderer/components/connector-mark";
import {
  ConnectNote,
  ConnectPending,
} from "#renderer/components/form-kit/connect-dialog";
import { Spinner } from "#renderer/components/spinner";
import { connectErrorText } from "#renderer/lib/connect-page";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { foldSearch } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import { Input } from "#renderer/ui/input";

import { useConnectFlow } from "./connect-flow";
import {
  connectorAdded,
  offeredConnectors,
  useConnectorStatuses,
} from "./connector-status";

const ConnectorFieldsDialog = lazy(() =>
  import("./connectors").then((module) => ({
    default: module.ConnectorFieldsDialog,
  }))
);

const ConnectorsPanel = () => {
  const { t } = useTranslation();
  const flow = useConnectFlow();
  const navigate = useAppNavigate();
  const { statuses } = useConnectorStatuses(flow);
  const [query, setQuery] = useState("");
  const entries = offeredConnectors(statuses.data, false).filter((e) =>
    foldSearch(e.name + " " + e.description).includes(foldSearch(query))
  );
  return (
    <>
      <Input
        aria-label={t("phase5.searchConnectors")}
        placeholder={t("phase5.searchConnectors")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div
        data-slot="composer-connectors"
        className="flex max-h-72 min-h-16 flex-col overflow-y-auto"
      >
        {statuses.data == null && statuses.isPending ? (
          <Spinner aria-hidden className="m-auto" />
        ) : entries.length === 0 ? (
          <p className="text-muted-foreground m-auto text-[13px]">
            {t("chat.composer.noConnectors")}
          </p>
        ) : (
          [true, false].map((group) => {
            const rows = entries.filter(
              (e) => connectorAdded(statuses.data?.[e.id]) === group
            );
            if (rows.length === 0) return null;
            return (
              <section key={String(group)}>
                <h3 className="text-muted-foreground px-2 pt-2 pb-1 text-xs font-normal">
                  {t(group ? "phase5.connected" : "phase5.add")}
                </h3>
                {rows.map((e) => {
                  // Installed, but its sign-in never finished: offer the sign-in.
                  const signIn =
                    statuses.data?.[e.id]?.reason === "sign-in-required";
                  const inFlight =
                    flow.state.connectorId === e.id &&
                    flow.state.phase !== "idle" &&
                    flow.state.phase !== "fields";
                  const error =
                    flow.state.connectorId === e.id
                      ? flow.state.error
                      : undefined;
                  return (
                    <div key={e.id} data-connector={e.id}>
                      <div className="flex min-h-9 items-center gap-2 px-2 text-[13px]">
                        <ConnectorMark id={e.logo ?? e.id} size={22} />
                        <span className="min-w-0 flex-1 truncate">
                          {e.name}
                        </span>
                        {inFlight ? null : group && !signIn ? (
                          <Check
                            role="img"
                            aria-label={t("phase5.connected")}
                            className="size-4 shrink-0 text-[var(--bots-done)]"
                          />
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => void flow.start(e.id)}
                          >
                            {t(signIn ? "phase5.signIn" : "phase5.add")}
                          </Button>
                        )}
                      </div>
                      {/* Its own line: beside the name it would cut the name off. */}
                      {inFlight && (
                        <ConnectPending
                          className="justify-between ps-10 pe-2 pb-1"
                          onCancel={() => void flow.cancel()}
                        />
                      )}
                      {error && (
                        <ConnectNote error className="px-2 pb-1.5">
                          {connectErrorText(t, error)}
                        </ConnectNote>
                      )}
                    </div>
                  );
                })}
              </section>
            );
          })
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground justify-start"
        onClick={() => void navigate({ to: "/library/connectors" })}
      >
        <Settings aria-hidden />
        {t("chat.composer.manageConnectors")}
      </Button>
    </>
  );
};

export const COMPOSER_CONNECTORS = {
  panel: <ConnectorsPanel />,
  overlay: (
    <Suspense fallback={null}>
      <ConnectorFieldsDialog />
    </Suspense>
  ),
};
