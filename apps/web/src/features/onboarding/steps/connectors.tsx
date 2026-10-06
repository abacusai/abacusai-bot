/**
 * `connectors` (canvas OnboardConnectors): a 4 × 3 grid of connector cards,
 * Connected / Connect from the live statuses, a dashed "Many more…" tile
 * that expands the rest of the catalogue inside the slide, and the two
 * continues. The curated set is the canvas's, in its order, limited to the
 * entries the inline flow (`connectOnboarding`) can attach without a form:
 * platform and messaging connectors. GitHub (a pasted token), Notion and
 * Stripe (MCP OAuth) wait in "Many more…" / Library; Linear does not exist.
 * Messaging tiles are Electron-only (the browser has no pairing), and a
 * tile whose status says `not-offered` is hidden (parity).
 */
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

/** Canvas order first; the old step's Discord and the rest of the flagged set after. */
export const CURATED_IDS = [
  "abacus-gmailuser",
  "abacus-googlecalendar",
  "abacus-googledriveuser",
  "abacus-slack",
  "messaging-whatsapp",
  "messaging-telegram",
  "messaging-discord",
  "abacus-jira",
  "abacus-figmauser",
  "abacus-outlook",
  "abacus-dropbox",
] as const;

const offered = (
  entry: Connector,
  statuses: ConnectorStatuses | undefined
): boolean =>
  (IS_ELECTRON || entry.kind !== "messaging") &&
  statuses?.[entry.id]?.reason !== "not-offered";

/**
 * The tiles in grid order: the curated set, then (when expanded) every other
 * onboarding-flagged entry and every other platform entry, registry order.
 */
export const connectorTiles = (
  statuses: ConnectorStatuses | undefined,
  more: boolean
): Connector[] => {
  const curated = CURATED_IDS.flatMap((id) =>
    CONNECTORS.filter((entry) => entry.id === id)
  );
  const rest = more
    ? CONNECTORS.filter(
        (entry) =>
          !(CURATED_IDS as readonly string[]).includes(entry.id) &&
          (entry.onboarding || entry.kind === "platform")
      )
    : [];
  return [...curated, ...rest].filter((entry) => offered(entry, statuses));
};

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
  const tiles = connectorTiles(statuses, more);
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
              className="onboarding-tile onboarding-card flex items-center gap-2.5 border border-transparent py-2.5 pr-2.5 pl-3"
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
        {!more && (
          <li className="contents">
            <button
              type="button"
              className="onboarding-quiet hover:text-foreground flex min-h-12 items-center justify-center rounded-xl border border-dashed p-2.5 transition-colors"
              onClick={() => setMore(true)}
            >
              {t("onboarding.connectorsMore")}
            </button>
          </li>
        )}
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
