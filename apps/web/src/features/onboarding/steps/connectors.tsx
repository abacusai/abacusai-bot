import { CONNECTORS, type Connector } from "@abacus-ai/connectors/registry";
import { CheckIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type Ref } from "react";

import { ConnectorMark } from "#renderer/components/connector-mark";
import { usePrefs } from "#renderer/data/db/prefs";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { Button } from "#renderer/ui/button";

import type { StepContext } from "./context";
import { StepBody, StepButton, StepTitle } from "./kit";

export type ConnectorStatuses = Record<
  string,
  { state?: string; reason?: string } | undefined
>;

export const CURATED_IDS = [
  "messaging-whatsapp",
  "messaging-telegram",
  "messaging-discord",
  "abacus-gmailuser",
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
  refresh,
  heading,
}: {
  ctx: StepContext;
  statuses: ConnectorStatuses | undefined;
  refresh(): Promise<unknown>;
  heading: Ref<HTMLHeadingElement>;
}) => {
  const { t, busy, props, perform, advance } = ctx;
  const prefs = usePrefs();
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const tiles = connectorTiles(statuses);
  const connectedAny = tiles.some(
    (entry) => statuses?.[entry.id]?.state === "connected"
  );
  const queuedAny = (prefs.onboardingPairing?.length ?? 0) > 0;
  const finish = advance;
  return (
    <>
      <StepTitle ref={heading} size="medium">
        {t("onboarding.connectorsTitleLead")}{" "}
        <span className="onboarding-accent">
          {t("onboarding.connectorsTitleAccent")}
        </span>
      </StepTitle>
      <StepBody className="mt-1.5 max-w-[640px]">
        {t("onboarding.pages.connectors.body")}
      </StepBody>
      <ul
        className="mt-5 grid w-full grid-cols-2 gap-2 min-[900px]:grid-cols-3"
        data-slot="connector-grid"
      >
        {tiles.map((entry) => {
          const connected = statuses?.[entry.id]?.state === "connected";
          const state =
            pending === entry.id
              ? "connecting"
              : failed === entry.id || statuses?.[entry.id]?.state === "error"
                ? "error"
                : connected
                  ? "connected"
                  : "idle";
          return (
            <li key={entry.id} className="min-w-0">
              <Button
                variant="outline"
                className="data-[connected=true]:border-primary data-[connected=true]:bg-primary/5 h-9 w-full justify-between gap-2 px-3 text-[13px] transition-colors"
                data-connector={entry.id}
                data-connected={connected}
                data-state={state}
                aria-pressed={connected}
                aria-busy={state === "connecting"}
                disabled={busy || connected}
                onClick={() =>
                  void perform(async () => {
                    setPending(entry.id);
                    setFailed(null);
                    try {
                      await props.connect?.(entry.id);
                      await refresh();
                    } catch (error) {
                      setFailed(entry.id);
                      throw error;
                    } finally {
                      setPending(null);
                    }
                  })
                }
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ConnectorMark
                    id={entry.logo ?? entry.id}
                    initial={entry.name.slice(0, 1)}
                    size={20}
                  />
                  <span className="truncate">{entry.name}</span>
                </span>
                <span
                  className="flex size-4 shrink-0 items-center justify-center"
                  data-slot="connector-state"
                >
                  {state === "connected" && (
                    <>
                      <CheckIcon className="text-primary size-3.5" />
                      <span className="sr-only">
                        {t("onboarding.pages.connectedLabel")}
                      </span>
                    </>
                  )}
                  {state === "connecting" && (
                    <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
                  )}
                  {state === "error" && (
                    <>
                      <TriangleAlertIcon className="text-destructive size-3.5" />
                      <span className="sr-only">{t("common.retry")}</span>
                    </>
                  )}
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <StepButton disabled={busy} onClick={finish}>
          {t("onboarding.connectorsContinue")}
        </StepButton>
        {!connectedAny && !queuedAny && (
          <StepButton variant="secondary" disabled={busy} onClick={finish}>
            {t("onboarding.connectorsSkipCta")}
          </StepButton>
        )}
      </div>
    </>
  );
};
