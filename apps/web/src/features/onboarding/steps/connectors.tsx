/**
 * `connectors` (canvas OnboardConnectors): the card grid of the registry's
 * onboarding entries with Connected/Connect, "Many more" and the two
 * continues. Connect goes through the route's `connectOnboarding`.
 */
import { CONNECTORS } from "@abacus-ai/connectors/registry";
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

export const ConnectorsStep = ({
  ctx,
  statuses,
  refresh,
  more,
  setMore,
  heading,
}: {
  ctx: StepContext;
  statuses: ConnectorStatuses | undefined;
  refresh(): Promise<unknown>;
  more: boolean;
  setMore(more: boolean): void;
  heading: Ref<HTMLHeadingElement>;
}) => {
  const { t, busy, props, perform, advance } = ctx;
  const prefs = usePrefs();
  const entries = CONNECTORS.filter(
    (c) => c.onboarding || (more && c.kind === "platform")
  )
    .filter((c) => IS_ELECTRON || c.kind !== "messaging")
    .filter((c) => statuses?.[c.id]?.reason !== "not-offered");
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
      <div className="mt-7 grid w-full max-w-[760px] grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {entries.map((c) => {
          const connected = statuses?.[c.id]?.state === "connected";
          const deferred = prefs.onboardingPairing?.includes(
            c.id.replace("messaging-", "") as never
          );
          return (
            <div
              key={c.id}
              className="onboarding-tile onboarding-card flex items-center gap-2.5 border border-transparent py-2.5 pr-2.5 pl-3"
              data-connected={connected}
            >
              <ConnectorMark
                id={c.logo ?? c.id}
                initial={c.name.slice(0, 1)}
                size={28}
              />
              <span className="min-w-0 flex-1 truncate text-[13px]">
                {c.name}
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
                      await props.connect?.(c.id);
                      await refresh();
                    })
                  }
                >
                  {deferred
                    ? t("onboarding.pages.deferred")
                    : t("onboarding.pages.connectLabel")}
                </StepLink>
              )}
            </div>
          );
        })}
        {!more && (
          <button
            type="button"
            className="onboarding-quiet flex min-h-12 items-center justify-center rounded-xl border border-dashed p-2.5"
            onClick={() => setMore(true)}
          >
            {t("onboarding.connectorsMore")}
          </button>
        )}
      </div>
      <div className="mt-8 flex flex-wrap justify-center gap-2.5">
        <StepButton disabled={busy} onClick={finish}>
          {t("onboarding.connectorsContinue")}
        </StepButton>
        <StepButton variant="secondary" disabled={busy} onClick={finish}>
          {t("onboarding.connectorsSkipCta")}
        </StepButton>
      </div>
    </>
  );
};
