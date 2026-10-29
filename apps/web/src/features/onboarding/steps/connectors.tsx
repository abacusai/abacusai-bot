import { CONNECTORS, type Connector } from "@abacus-ai/connectors/registry";
import { CheckIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import type { Ref } from "react";

import { ConnectorMark } from "#renderer/components/connector-mark";
import { usePrefs } from "#renderer/data/db/prefs";
import { connectErrorText } from "#renderer/lib/connect-page";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { useRowConnects } from "#renderer/lib/use-row-connects";
import { Button } from "#renderer/ui/button";

import { ConnectFailed } from "../connect";
import type { StepContext } from "./context";
import { StepBody, StepButton, StepTitle } from "./kit";

export type ConnectorStatuses = Record<
  string,
  { state?: string; reason?: string } | undefined
>;

export const CURATED_IDS = [
  "abacus-gmailuser",
  "messaging-whatsapp",
  "messaging-telegram",
  "messaging-discord",
] as const;

const offered = (
  entry: Connector,
  statuses: ConnectorStatuses | undefined
): boolean =>
  (IS_ELECTRON || entry.kind !== "messaging") &&
  statuses?.[entry.id]?.reason !== "not-offered";

export const connectorTiles = (
  statuses: ConnectorStatuses | undefined
): Connector[] =>
  CURATED_IDS.flatMap((id) =>
    CONNECTORS.filter((entry) => entry.id === id)
  ).filter((entry) => offered(entry, statuses));

export const ConnectorsStep = ({
  ctx,
  statuses,
  loading = false,
  refresh,
  heading,
}: {
  ctx: StepContext;
  statuses: ConnectorStatuses | undefined;
  /** Statuses not read yet: tiles wait instead of showing "Connect". */
  loading?: boolean;
  refresh(): Promise<unknown>;
  heading: Ref<HTMLHeadingElement>;
}) => {
  const { t, busy, props, advance } = ctx;
  const prefs = usePrefs();
  // Each tile connects on its own: the page never waits on a connector, so a
  // sign-in left open in the browser blocks neither the other tiles nor Continue.
  const rows = useRowConnects();
  const start = (id: string) =>
    rows.start(id, {
      run: async () => {
        try {
          await props.connect?.(id);
          return { ok: true };
        } catch (error) {
          // Backing out of the sign-in is not a failure: the tile goes back to Connect.
          if (error instanceof ConnectFailed && error.message === "timeout")
            return { ok: false, cancelled: true, error: error.message };
          return {
            ok: false,
            error:
              error instanceof ConnectFailed
                ? connectErrorText(t, error.message)
                : t("onboarding.frame.failed"),
          };
        }
      },
      cancel: () => props.cancelConnect?.(id),
      // Connected shows from the statuses, which the host also announces.
      connected: refresh,
    });
  const tiles = connectorTiles(statuses);
  const connectedAny = tiles.some(
    (entry) => statuses?.[entry.id]?.state === "connected"
  );
  const queuedAny = (prefs.onboardingPairing?.length ?? 0) > 0;
  const finish = advance;
  return (
    <>
      <StepTitle ref={heading} size="medium" className="text-center">
        {t("onboarding.connectorsTitleLead")}{" "}
        <span className="onboarding-accent">
          {t("onboarding.connectorsTitleAccent")}
        </span>
        <br />
        {t("onboarding.connectorsSubtitle")}
      </StepTitle>
      <StepBody className="mx-auto mt-2 max-w-[520px] text-center">
        {t("onboarding.pages.connectors.body")}
      </StepBody>
      <ul
        className="mt-5 grid w-full grid-cols-1 items-start gap-2.5 min-[640px]:grid-cols-2"
        data-slot="connector-grid"
      >
        {tiles.map((entry) => {
          const connected = statuses?.[entry.id]?.state === "connected";
          const reason = rows.error(entry.id) ?? undefined;
          const state = loading
            ? "loading"
            : connected
              ? "connected"
              : rows.waiting(entry.id)
                ? "connecting"
                : reason != null || statuses?.[entry.id]?.state === "error"
                  ? "error"
                  : "idle";
          return (
            <li key={entry.id} className="relative min-w-0">
              <Button
                variant="outline"
                className="data-[connected=true]:border-primary data-[connected=true]:bg-primary/5 h-auto w-full items-center justify-start gap-3 rounded-xl p-3 text-left whitespace-normal transition-colors disabled:opacity-100 data-[state=connecting]:pe-24"
                data-connector={entry.id}
                data-connected={connected}
                data-state={state}
                aria-label={t("onboarding.connectorAction", {
                  action: t(
                    connected
                      ? "onboarding.connectorsConnectedCta"
                      : "onboarding.connectorsConnectCta"
                  ),
                  name: entry.name,
                })}
                aria-describedby={`onboarding-${entry.id}-description`}
                aria-pressed={connected}
                aria-busy={state === "connecting" || state === "loading"}
                disabled={busy || connected || state === "loading"}
                onClick={() => start(entry.id)}
              >
                <ConnectorMark
                  id={entry.logo ?? entry.id}
                  initial={entry.name.slice(0, 1)}
                  size={48}
                />
                <span className="flex min-w-0 flex-col items-start gap-1">
                  <span className="text-left text-sm font-semibold">
                    {entry.name}
                  </span>
                  <span
                    id={`onboarding-${entry.id}-description`}
                    className="text-muted-foreground text-xs leading-4 font-normal"
                  >
                    {t(`onboarding.connectorDetails.${entry.id}`)}
                  </span>
                  <span
                    className="text-primary flex items-center justify-start gap-1.5 text-xs"
                    data-slot="connector-state"
                  >
                    {state === "connected" && (
                      <>
                        <CheckIcon className="text-primary size-3.5" />
                        <span>{t("onboarding.pages.connectedLabel")}</span>
                      </>
                    )}
                    {(state === "connecting" || state === "loading") && (
                      <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
                    )}
                    {state === "idle" && t("onboarding.connectorsConnectCta")}
                    {state === "connecting" && t("phase5.waitingSignIn")}
                    {state === "loading" && t("common.loading")}
                    {state === "error" && (
                      <>
                        <TriangleAlertIcon className="text-destructive size-3.5" />
                        <span>{t("onboarding.pages.retry")}</span>
                      </>
                    )}
                  </span>
                  {state === "error" && reason != null && (
                    <span
                      className="text-destructive text-xs leading-4 font-normal"
                      role="alert"
                    >
                      {reason}
                    </span>
                  )}
                </span>
              </Button>
              {state === "connecting" && (
                // Beside the tile, not in it: a button cannot hold another.
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground absolute end-2 top-1/2 -translate-y-1/2 text-[13px]"
                  data-slot="connector-cancel"
                  onClick={() => rows.cancel(entry.id)}
                >
                  {t("phase5.cancel")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <StepButton disabled={busy} onClick={finish}>
          {t("onboarding.connectorsContinue")}
        </StepButton>
        {!loading && !connectedAny && !queuedAny && (
          <StepButton variant="secondary" disabled={busy} onClick={finish}>
            {t("onboarding.connectorsSkipCta")}
          </StepButton>
        )}
      </div>
    </>
  );
};
