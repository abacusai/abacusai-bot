import { CONNECTORS, type Connector } from "@abacus-ai/connectors/registry";
import type { Ref } from "react";

import { ConnectorMark } from "#renderer/components/connector-mark";
import { usePrefs } from "#renderer/data/db/prefs";
import { IS_ELECTRON } from "#renderer/lib/platform";

import type { StepContext } from "./context";
import {
  ConnectedMark,
  StepBody,
  StepButton,
  StepLink,
  StepTitle,
} from "./kit";

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
  const tiles = connectorTiles(statuses);
  const connectedAny = tiles.some(
    (entry) => statuses?.[entry.id]?.state === "connected"
  );
  const queuedAny = (prefs.onboardingPairing?.length ?? 0) > 0;
  const finish = () => {
    if (!props.facts.ownsBot)
      void perform(() => props.complete({ to: "new-bot" }));
    else advance();
  };
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
        className="mt-7 grid w-full max-w-[760px] grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4"
        data-slot="connector-grid"
      >
        {tiles.map((entry) => {
          const connected = statuses?.[entry.id]?.state === "connected";
          const deferred = prefs.onboardingPairing?.includes(
            entry.id.replace("messaging-", "") as never
          );
          return (
            <li
              key={entry.id}
              className="bg-card border-border data-[connected=true]:border-primary flex items-center gap-2.5 rounded-(--radius) border py-3 pr-3 pl-4"
              data-connector={entry.id}
              data-connected={connected}
            >
              <ConnectorMark
                id={entry.logo ?? entry.id}
                initial={entry.name.slice(0, 1)}
                size={28}
              />
              <span className="min-w-0 flex-1 truncate text-[13px]">
                {entry.name}
              </span>
              {connected ? (
                <ConnectedMark>
                  {t("onboarding.pages.connectedLabel")}
                </ConnectedMark>
              ) : (
                <StepLink
                  className="-mr-1 h-7 px-2 text-xs"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await props.connect?.(entry.id);
                      await refresh();
                    })
                  }
                >
                  {deferred
                    ? t("onboarding.pages.deferred")
                    : t("onboarding.pages.connectLabel")}
                </StepLink>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-8 flex flex-wrap justify-center gap-2.5">
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
