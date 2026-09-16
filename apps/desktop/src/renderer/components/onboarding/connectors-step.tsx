import { ArrowRight, Check, Link2, Loader2 } from "lucide-react";
import { useEffect, useState, type JSX, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  CONNECTORS,
  connectUi,
  type ConnectorDefinition,
  type PlatformConnector,
} from "../../connectors";
import {
  isConnected,
  statusOf,
  useConnectorStatuses,
} from "../../hooks/use-connector-statuses";
import { cn } from "../../lib/cn";
import { useConnectFlow } from "../connectors/connect-flow";
import { ConnectorLogo } from "../settings/connector-logo";
import { Button } from "../ui";

/**
 * Attach the tools you already work in. Every tile attaches in place through
 * the same flow as the Connectors page — a browser hop, a pairing dialog —
 * and the tiles come from the registry, so there is no second list.
 */

/** The four this step leads with; messaging first, since an agent you can text is a different product. */
const OFFERED_IDS = [
  "messaging-whatsapp",
  "messaging-telegram",
  "messaging-discord",
  "abacus-gmailuser",
] as const;

const isOffered = (connector: ConnectorDefinition): boolean =>
  (OFFERED_IDS as readonly string[]).includes(connector.id);

const OFFERED: ConnectorDefinition[] = OFFERED_IDS.flatMap((id) =>
  CONNECTORS.filter((connector) => connector.id === id)
);

/** The rest of the account connectors, shown in place on request. */
const MORE_CONNECTORS = CONNECTORS.filter(
  (connector): connector is PlatformConnector =>
    connector.kind === "platform" && !isOffered(connector)
);

export const ConnectorsStep = ({
  onBack,
  onNext,
  dots,
}: {
  /** Back to the previous screen. */
  onBack: () => void;
  /** On to the next screen, with or without anything attached. */
  onNext: () => void;
  /** The flow's progress dots, so this step doesn't own the shell's chrome. */
  dots: ReactNode;
}): JSX.Element => {
  const { t } = useTranslation();
  const { statuses, loaded, refresh } = useConnectorStatuses();
  const flow = useConnectFlow();
  /** The connector whose browser hop is in flight; the hop is single-flight. */
  const [attaching, setAttaching] = useState<string | null>(null);
  /** Has the user asked for the rest of the catalog on this screen? */
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Leaving the step abandons any connect in flight, or the loopback listener
  // holds its port for the full five-minute window.
  useEffect(() => () => flow.cancel(), [flow]);

  /**
   * Give up on the hop in flight: it resolves on the loopback ping or after
   * five minutes, and every tile is disabled until it does.
   */
  const cancelAttach = (): void => {
    flow.cancel();
    setAttaching(null);
  };

  const attach = async (connector: ConnectorDefinition): Promise<void> => {
    // Only a browser hop is single-flight and worth a spinner; a dialog is
    // its own affair.
    const hop = connectUi(connector) === "browser-hop";
    if (hop && attaching != null) cancelAttach();
    if (hop) setAttaching(connector.id);
    setError(null);
    try {
      const result = await flow.start(connector);
      if (result.ok === true) {
        await refresh();
        return;
      }
      if (result.cancelled !== true)
        setError(t("connectors.abacusConnectFailed", { name: connector.name }));
    } finally {
      // Only stand down if this hop still owns the spinner: clicking another
      // tile cancels this one, and that cancellation resolves this promise.
      setAttaching((current) => (current === connector.id ? null : current));
    }
  };

  // A connector the account cannot offer is dropped rather than shown failing
  // — once the statuses are in; until then, every tile.
  const tiles = OFFERED.filter(
    (connector) =>
      connector.kind !== "platform" ||
      !loaded ||
      statusOf(statuses, connector.id).reason !== "not-offered"
  );

  const hasConnected = CONNECTORS.some((connector) =>
    isConnected(statuses, connector.id)
  );

  return (
    <div className="@container flex flex-col" data-id="onboarding-connectors">
      {flow.dialogs}
      <div className="flex items-center justify-between">
        <Button
          variant="link"
          size="sm"
          onClick={onBack}
          aria-label={t("common.back")}
          className="text-muted-foreground hover:text-secondary-foreground text-xs"
        >
          {t("common.back")}
        </Button>
      </div>

      <div className="flex flex-col items-center text-center">
        {/* No logo or product name: three screens in, the window has said whose it is. */}
        <h1 className="text-foreground text-4xl font-bold tracking-tight text-balance">
          {t("onboarding.connectorsTitleLead")}{" "}
          <span className="text-primary">
            {t("onboarding.connectorsTitleAccent")}
          </span>
          <br />
          {t("onboarding.connectorsSubtitle")}
        </h1>
      </div>

      <div
        className="mt-8 grid grid-cols-2 gap-3 @xl:grid-cols-4"
        data-id="onboarding-connectors-grid"
      >
        {tiles.map((connector) => {
          const connected = isConnected(statuses, connector.id);
          const isAttaching = attaching === connector.id;

          return (
            <div
              key={connector.id}
              data-id={`onboarding-connector-${connector.id}`}
              data-connected={connected ? "" : undefined}
              title={connector.description}
              className={cn(
                "border-border bg-card/60 flex flex-col items-center gap-3 rounded-2xl border p-4",
                connected && "border-primary/50"
              )}
            >
              <span className="flex size-12 items-center justify-center [&_img]:size-10 [&_svg]:size-10">
                <ConnectorLogo connector={connector} />
              </span>
              <span className="text-foreground text-sm font-semibold">
                {connector.name}
              </span>

              {/* A button in the card, not a card that is a button: these are
                  picked together, not chosen between. */}
              <Button
                variant="outline"
                size="sm"
                data-id={`onboarding-connector-${connector.id}-connect`}
                disabled={connected}
                onClick={() => void attach(connector)}
                className={cn(
                  "w-full",
                  connected
                    ? "border-transparent bg-emerald-500/10 text-emerald-700 disabled:opacity-100 dark:text-emerald-400"
                    : "text-primary border-primary/40"
                )}
              >
                {isAttaching ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : connected ? (
                  <Check className="size-3.5" />
                ) : (
                  <Link2 className="size-3.5" />
                )}
                {connected
                  ? t("onboarding.connectorsConnectedCta")
                  : t("onboarding.connectorsConnectCta")}
              </Button>
            </div>
          );
        })}
      </div>

      {!showAll && (
        <div className="mt-6 flex justify-center">
          <Button
            variant="link"
            data-id="onboarding-connectors-more"
            onClick={() => setShowAll(true)}
            className="text-primary text-base font-semibold"
          >
            {t("onboarding.connectorsMore")}
            <ArrowRight className="size-4" />
          </Button>
        </div>
      )}

      {showAll && (
        <div
          className="mt-4 grid max-h-56 grid-cols-2 gap-2 overflow-y-auto @xl:grid-cols-4"
          data-id="onboarding-connectors-all"
        >
          {MORE_CONNECTORS.map((connector) => {
            const connected = isConnected(statuses, connector.id);

            return (
              <Button
                key={connector.id}
                variant="outline"
                size="sm"
                data-id={`onboarding-connector-${connector.id}-connect`}
                disabled={connected}
                onClick={() => void attach(connector)}
                className="h-auto justify-start gap-2 py-2"
              >
                <span className="flex size-5 items-center justify-center [&_img]:size-5 [&_svg]:size-5">
                  <ConnectorLogo connector={connector} />
                </span>
                <span className="truncate text-xs font-medium">
                  {connector.name}
                </span>
                {connected && (
                  <Check className="ml-auto size-3.5 text-emerald-600" />
                )}
              </Button>
            );
          })}
        </div>
      )}

      {error != null && (
        <div
          className="text-destructive mt-4 text-xs"
          data-id="onboarding-connectors-error"
        >
          {error}
        </div>
      )}

      {/* One button on; the label says whether anything was attached. */}
      <div className="mt-8 flex flex-col items-center gap-5">
        <Button
          size="lg"
          data-id="onboarding-connectors-next"
          onClick={onNext}
          className="from-primary h-14 w-full bg-gradient-to-b to-violet-700 text-base font-semibold shadow-lg"
        >
          {hasConnected
            ? t("onboarding.connectorsContinueCta")
            : t("onboarding.connectorsSkipCta")}
          <ArrowRight className="size-5" />
        </Button>

        {/* Only while a hop is out. */}
        {attaching != null && (
          <Button
            variant="link"
            size="sm"
            data-id="onboarding-connectors-cancel"
            onClick={cancelAttach}
            className="text-muted-foreground hover:text-secondary-foreground -mt-2 text-xs"
          >
            {t("common.cancel")}
          </Button>
        )}

        {dots}
      </div>
    </div>
  );
};
