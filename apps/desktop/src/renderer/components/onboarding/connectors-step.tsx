import { ArrowRight, Check, Link2, Loader2 } from "lucide-react";
import { useEffect, useState, type JSX, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { MessagingPlatformId } from "#shared/messaging";

import {
  CONNECTORS,
  type AbacusConnector,
  type ConnectorDefinition,
  type MessagingConnector,
} from "../../connectors";
import { cn } from "../../lib/cn";
import { ConnectorLogo } from "../settings/connector-logo";
import {
  MessagingConnectorDialog,
  isMessagingPlatformConnected,
  useMessaging,
} from "../settings/messaging-connectors";
import { Button } from "../ui";

/**
 * Attach the tools you already work in. Every tile attaches in place, one
 * browser hop each; signed out, the tap runs the sign-in hop first. The grid
 * is the catalog's own connector list, so there is no second place to update.
 */

/**
 * What the account buys, as pills above the logos: signed out, the logos alone
 * say nothing about the built-in tools or the price.
 */
/** The four this step offers, in order; the rest are in Settings. */

const OFFERED_IDS = [
  "messaging-whatsapp",
  "messaging-telegram",
  "messaging-discord",
  "abacus-gmailuser",
] as const;

/**
 * The three messaging platforms, then Gmail. Messaging leads: an agent you can
 * text is a different product from one you visit.
 */
const OFFERED: ConnectorDefinition[] = OFFERED_IDS.map((id) =>
  CONNECTORS.find((connector) => connector.id === id)!
).filter(Boolean);

/** Everything this screen does not lead with, opened in place on request. */
const MORE_CONNECTORS = CONNECTORS.filter(
  (connector) =>
    connector.auth === "abacus" && !OFFERED_IDS.includes(connector.id as never)
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
  const moreLogos = MORE_CONNECTORS;

  const [connected, setConnected] = useState<Set<string>>(new Set());
  const [available, setAvailable] = useState<Set<string> | null>(null);
  /** The service whose browser hop is in flight; the hop is single-flight. */
  const [attaching, setAttaching] = useState<string | null>(null);
  /** Has the user asked for the rest of the catalog on this screen? */
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The messaging tiles connect through the gateway rather than a browser hop:
  // the dialog carries WhatsApp's QR and the bot-token fields.
  const messaging = useMessaging();
  const [messagingDialog, setMessagingDialog] =
    useState<MessagingPlatformId | null>(null);

  /** What the platform says is attached — the source of truth, not the ping. */
  const refresh = async (): Promise<void> => {
    const snapshot = await window.api.agent.listAbacusConnectors();
    if (snapshot.ok !== true) return;
    setConnected(new Set(Object.keys(snapshot.connected)));
    setAvailable(new Set(snapshot.available.map((item) => item.service)));
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Leaving the step abandons any connect in flight, or the loopback listener
  // holds its port for the full five-minute window.
  useEffect(
    () => () => {
      void window.api?.agent?.cancelAbacusConnector?.();
    },
    []
  );

  /**
   * Give up on the hop in flight: it resolves on the loopback ping or after
   * five minutes, and every tile is disabled until it does.
   */
  const cancelAttach = (): void => {
    void window.api?.agent?.cancelAbacusConnector?.();
    setAttaching(null);
  };

  const attach = async (connector: AbacusConnector): Promise<void> => {
    const service = connector.abacusService;
    setAttaching(service);
    setError(null);
    try {
      const result = await window.api.agent.connectAbacusConnector(service);
      if (result.ok === true) {
        await refresh();
        return;
      }
      if (result.cancelled !== true)
        setError(t("connectors.abacusConnectFailed", { name: connector.name }));
    } finally {
      // Only stand down if this hop still owns the spinner: clicking another
      // tile cancels this one, and that cancellation resolves this promise.
      setAttaching((current) => (current === service ? null : current));
    }
  };

  const openMessaging = (connector: MessagingConnector): void => {
    if (attaching != null) cancelAttach();
    // WhatsApp, Telegram and Discord are linked-device platforms: connecting is
    // what starts them, so enable on open.
    if (
      connector.messagingPlatform === "whatsapp" ||
      connector.messagingPlatform === "telegram" ||
      connector.messagingPlatform === "discord" ||
      connector.messagingPlatform === "abacus_discord" ||
      connector.messagingPlatform === "abacus_telegram"
    )
      void messaging.connectPlatform(connector.messagingPlatform);
    setMessagingDialog(connector.messagingPlatform);
  };

  // Connected means CONNECTED (a live socket, a scanned QR), never the stored
  // enable flag, which survives its own credentials being cleared.
  const isTileConnected = (connector: ConnectorDefinition): boolean =>
    connector.auth === "messaging"
      ? isMessagingPlatformConnected(
          messaging.snapshot,
          connector.messagingPlatform
        )
      : connector.auth === "abacus"
        ? connected.has(connector.abacusService)
        : false;

  // A connector the account cannot offer is dropped rather than shown failing.
  const tiles = OFFERED.filter(
    (connector) =>
      connector.auth !== "abacus" ||
      available == null ||
      available.has(connector.abacusService)
  );

  // Any connector counts: the messaging tiles live in the gateway snapshot,
  // not in `connected`.

  const hasConnected = connected.size > 0 || tiles.some(isTileConnected);

  return (
    <div className="@container flex flex-col" data-id="onboarding-connectors">
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
        {/* No mark and no product name here. The user is inside the app, three
            screens into its first run — the window has already said whose it
            is, and repeating it on every step spends the top of the screen on
            what they already know instead of on what the step is asking. */}
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
          const isConnected = isTileConnected(connector);
          const isAttaching =
            connector.auth === "abacus" &&
            attaching === connector.abacusService;

          return (
            <div
              key={connector.id}
              data-id={`onboarding-connector-${connector.id}`}
              data-connected={isConnected ? "" : undefined}
              title={connector.description}
              className={cn(
                "border-border bg-card/60 flex flex-col items-center gap-3 rounded-2xl border p-4",
                isConnected && "border-primary/50"
              )}
            >
              <span className="flex size-12 items-center justify-center [&_img]:size-10 [&_svg]:size-10">
                <ConnectorLogo connector={connector} />
              </span>
              <span className="text-foreground text-sm font-semibold">
                {connector.name}
              </span>

              {/* The control lives in the card rather than the card being the
                  control: four cards that are each one big button read as a
                  choice of one, and these are meant to be picked together. */}
              <Button
                variant="outline"
                size="sm"
                data-id={`onboarding-connector-${connector.id}-connect`}
                disabled={isConnected}
                onClick={() =>
                  connector.auth === "messaging"
                    ? openMessaging(connector)
                    : void attach(connector as AbacusConnector)
                }
                className={cn(
                  "w-full",
                  isConnected
                    ? "border-transparent bg-emerald-500/10 text-emerald-700 disabled:opacity-100 dark:text-emerald-400"
                    : "text-primary border-primary/40"
                )}
              >
                {isAttaching ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : isConnected ? (
                  <Check className="size-3.5" />
                ) : (
                  <Link2 className="size-3.5" />
                )}
                {isConnected
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
          {moreLogos.map((connector) => {
            const service = (connector as AbacusConnector).abacusService;
            const isConnected = connected.has(service);

            return (
              <Button
                key={connector.id}
                variant="outline"
                size="sm"
                data-id={`onboarding-connector-${connector.id}-connect`}
                disabled={isConnected}
                onClick={() => void attach(connector as AbacusConnector)}
                className="h-auto justify-start gap-2 py-2"
              >
                <span className="flex size-5 items-center justify-center [&_img]:size-5 [&_svg]:size-5">
                  <ConnectorLogo connector={connector} />
                </span>
                <span className="truncate text-xs font-medium">
                  {connector.name}
                </span>
                {isConnected && (
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

      {messagingDialog != null && (
        <MessagingConnectorDialog
          platformId={messagingDialog}
          messaging={messaging}
          onClose={() => setMessagingDialog(null)}
        />
      )}

      {/* One way on. Skip and Continue called the same handler — two buttons
          for one action, which only asks the user to wonder what the
          difference is. The label carries the difference instead. */}
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

        {/* Only while a hop is out: a permanent cancel would be a control for
            a state the user is not in. */}
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
