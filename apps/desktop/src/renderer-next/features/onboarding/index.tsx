import { CONNECTORS } from "@abacus-ai/connectors/registry";

import "./onboarding.css";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { BotAvatar } from "#next/components/bot-avatar";
import { ConnectorMark } from "#next/components/connector-mark";
import { useDb } from "#next/data/db";
import { usePrefs } from "#next/data/db/prefs";
import type { Transport } from "#next/data/transport";
import { resolveLook } from "#next/lib/bots/avatar";
import { useMotionPreference } from "#next/lib/motion";
import type { OnboardingStepId } from "#next/lib/navigation/areas";
import { useSharedElementName } from "#next/lib/navigation/shared-element";
import { Badge } from "#next/ui/badge";
import { Button } from "#next/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "#next/ui/dropdown-menu";
import { Spinner } from "#next/ui/spinner";

import type { OnboardingExit } from "./actions";
import {
  discardFirstBot,
  ensureFirstBot,
  firstBotStore,
  type FirstBotResult,
} from "./first-bot";
import { FirstBotHatch } from "./hatch";
import { next, connectedProviders, type FlowFacts } from "./machine";
import { onboardingStore } from "./store";
export { needsOnboarding, onboardingTarget, guardStep } from "./machine";
export {
  accountStateQuery,
  completeOnboarding,
  finishCompletion,
} from "./actions";
export { onboardingStore, startSignIn, cancelSignIn } from "./store";
export const OnboardingFrame = ({
  step,
  children,
}: {
  preview?: boolean;
  previewBot?: FirstBotResult;
  step: OnboardingStepId;
  children: ReactNode;
}) => {
  const { t } = useTranslation();
  const reduce = useMotionPreference() === "reduced";
  const mark = {
    welcome: 1,
    connect: 2,
    connected: 2,
    models: 3,
    connectors: 4,
    "first-bot": 5,
    done: 5,
  }[step];
  return (
    <div className="onboarding-frame" data-reduced-motion={reduce}>
      <div
        className="onboarding-progress"
        role="progressbar"
        aria-label={t("onboarding.frame.progress", { n: mark })}
        aria-valuemin={1}
        aria-valuemax={5}
        aria-valuenow={mark}
        aria-valuetext={t("onboarding.frame.progress", { n: mark })}
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <span key={n} data-current={n === mark} data-done={n < mark} />
        ))}
      </div>
      {children}
    </div>
  );
};
const Parade = () => (
  <div className="onboarding-parade" aria-hidden="true">
    {["bunny", "blob", "mochi", "cat", "star"].map((shape, i) => (
      <BotAvatar
        key={shape}
        look={resolveLook({
          name: shape,
          avatarShape: shape,
          avatarColor: ["pink", "green", "blue", "orange", "yellow"][i]!,
        })}
        size={[56, 72, 88, 72, 56][i]!}
      />
    ))}
  </div>
);
export interface OnboardingPageProps {
  preview?: boolean;
  previewBot?: FirstBotResult;
  step: OnboardingStepId;
  transport: Transport;
  facts: FlowFacts;
  navigate(step: OnboardingStepId): Promise<void>;
  signIn(intent: "signup" | "signin", profileId?: string): void;
  cancelSignIn(): Promise<void>;
  complete(exit: OnboardingExit): Promise<void>;
  createFirstBot(id: string): Promise<FirstBotResult>;
  addKey?: ReactNode;
  localModel?: ReactNode;
  connect?(id: string): Promise<unknown>;
}
export const OnboardingStepPage = (props: OnboardingPageProps) => {
  const { step, transport, facts } = props;
  const { t } = useTranslation();
  const db = useDb();
  const prefs = usePrefs();
  const liveFirst = useSelector(firstBotStore, (s) => s);
  const first = props.previewBot
    ? { state: "ready" as const, result: props.previewBot }
    : liveFirst;
  const attempt = useSelector(onboardingStore, (s) => s.signIn);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const bot = first.state === "ready" ? first.result.bot : null;
  const shared = useSharedElementName(
    step === "done" && bot ? `bot-identity-${bot.id}` : null
  );
  const profiles = useQuery({
    ...transport.orpc.auth.abacus.browserProfiles.queryOptions({ input: {} }),
    enabled: step === "welcome",
  });
  const models = useQuery({
    ...transport.orpc.models.list.queryOptions({ input: {} }),
    enabled: step === "models",
  });
  const keys = useQuery({
    ...transport.orpc.settings.keys.listProviders.queryOptions({ input: {} }),
    enabled: step === "models",
  });
  const statuses = useQuery({
    ...transport.orpc.connectors.statuses.queryOptions({ input: {} }),
    enabled: step === "connectors",
  });
  const { data: bots } = useLiveQuery(db.collections.bots);
  const defaultProfile = profiles.data?.find((profile) => profile.isDefault);
  const connected = connectedProviders(
    (models.data ?? []).filter((m) => m.configured),
    keys.data ?? []
  );
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  useEffect(() => {
    if (step !== "first-bot" || props.preview) return;
    ensureFirstBot(facts.ownsBot, props.createFirstBot);
  }, [step, facts.ownsBot, props]);
  useEffect(() => {
    if (
      !props.preview &&
      liveFirst.state === "ready" &&
      bots &&
      !bots.some((item) => item.id === liveFirst.result.bot.id)
    ) {
      firstBotStore.setState(() => ({ state: "removed" }));
    }
  }, [bots, liveFirst, props.preview]);
  const shownBot = useRef<string | null>(null);
  useEffect(() => {
    if (props.preview || step !== "first-bot" || liveFirst.state !== "ready")
      return;
    const id = liveFirst.result.bot.id;
    if (shownBot.current === id) return;
    shownBot.current = id;
    void transport.client.system.funnelStep({ step: "first_bot_shown" });
  }, [step, liveFirst, transport, props.preview]);
  useEffect(() => {
    if (
      !props.preview &&
      step === "first-bot" &&
      liveFirst.state === "skipped"
    ) {
      void transport.client.system.funnelStep({
        step: "first_bot_skipped",
        detail: liveFirst.reason,
      });
      void props.navigate("done");
    }
  }, [step, liveFirst, transport, props]);
  const perform = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch {
      setError(t("onboarding.frame.failed"));
    }
    setBusy(false);
  };
  const advance = () => {
    const target = next(step, { type: "next" }, facts, attempt?.id ?? null);
    if (target !== "ignore" && target !== "complete")
      void props.navigate(target);
  };
  const skip = () =>
    void perform(async () => {
      await props.cancelSignIn();
      await props.navigate("models");
    });
  const button = (label: string, action: () => void, secondary = false) => (
    <Button
      size="lg"
      className="h-11 rounded-xl px-6"
      variant={secondary ? "secondary" : "default"}
      disabled={busy}
      onClick={action}
    >
      {label}
    </Button>
  );
  const title =
    step === "welcome"
      ? t("onboarding.welcomeTitle")
      : step === "connected"
        ? t("onboarding.connectedTitleName")
        : t(`onboarding.pages.${step}.title`);
  return (
    <section className="onboarding-step" data-onboarding-step={step}>
      {step === "welcome" || (step === "done" && !bot) ? (
        <Parade />
      ) : (
        <div
          className={step === "first-bot" ? "relative" : undefined}
          style={shared}
        >
          {step === "first-bot" && bot ? (
            <FirstBotHatch
              look={resolveLook({
                name: bot.name,
                avatarShape: bot.avatarShape,
                avatarColor: bot.avatarColor,
              })}
            />
          ) : (
            <BotAvatar
              look={resolveLook({
                name: bot?.name ?? "Abacus",
                avatarShape: bot?.avatarShape ?? "mochi",
                avatarColor: bot?.avatarColor ?? "blue",
              })}
              size={96}
              mood={step === "connect" ? "waiting" : "idle"}
            />
          )}
        </div>
      )}
      <h1 ref={heading} tabIndex={-1}>
        {title}
      </h1>
      <p>
        {step === "welcome"
          ? t("onboarding.welcomeTagline")
          : t(`onboarding.pages.${step}.body`)}
      </p>
      {step === "welcome" && (
        <>
          <div className="flex flex-wrap justify-center gap-2">
            {[
              "welcomeFreeBadge",
              "welcomeModels",
              "welcomeConnectors",
              "welcomeMemory",
            ].map((key) => (
              <Badge key={key} variant="secondary">
                {t(`onboarding.${key}`)}
              </Badge>
            ))}
          </div>
          {button(t("onboarding.connectCta"), () => props.signIn("signup"))}
          <div className="flex items-center gap-1">
            {button(
              defaultProfile
                ? t("onboarding.haveAccountContinueWith", {
                    browser: defaultProfile.browserName,
                  })
                : t("onboarding.haveAccountCta"),
              () => props.signIn("signin", defaultProfile?.id),
              true
            )}
            {!!profiles.data?.length && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="secondary"
                      aria-label={t("onboarding.signInOptions")}
                    />
                  }
                >
                  ⌄
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {profiles.data.map((profile) => (
                    <DropdownMenuItem
                      key={profile.id}
                      onClick={() => props.signIn("signin", profile.id)}
                    >
                      {t("onboarding.continueWithBrowser", {
                        browser: profile.browserName,
                        profile: profile.profileName,
                      })}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem onClick={() => props.signIn("signin")}>
                    {t("onboarding.signInAnotherWay")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          {defaultProfile && (
            <p>
              {t("onboarding.usesBrowserSessions", {
                browser: defaultProfile.browserName,
              })}
            </p>
          )}
          <Button variant="ghost" onClick={skip}>
            {t("onboarding.pages.skip")}
          </Button>
        </>
      )}
      {step === "connect" && (
        <>
          <div role="status" className="flex items-center gap-2">
            {(props.preview || attempt?.status === "pending") && <Spinner />}
            {t("onboarding.pages.connect.waiting")}
          </div>
          {attempt?.status === "failed" && (
            <p role="alert">
              {t(
                attempt.outcome &&
                  !attempt.outcome.ok &&
                  attempt.outcome.error === "unidentified-account"
                  ? "onboarding.abacusUnidentified"
                  : "onboarding.frame.failed"
              )}
            </p>
          )}
          {attempt?.status === "failed" &&
            button(t("onboarding.pages.retry"), () =>
              props.signIn(attempt.intent, attempt.profileId)
            )}
          <Button
            variant="ghost"
            onClick={() => void transport.client.auth.abacus.openInBrowser({})}
          >
            {t("onboarding.openInBrowserCta")}
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              void perform(async () => {
                await props.cancelSignIn();
                props.signIn("signin");
              })
            }
          >
            {t("onboarding.signInAnotherWay")}
          </Button>
          <Button variant="ghost" onClick={skip}>
            {t("onboarding.pages.skip")}
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              void perform(async () => {
                await props.cancelSignIn();
                await props.navigate("welcome");
              })
            }
          >
            {t("common.cancel")}
          </Button>
        </>
      )}
      {step === "connected" && (
        <>
          {[1, 2, 3, 4].map((n) => (
            <p key={n}>{t(`onboarding.pages.connected.promise${n}`)}</p>
          ))}
          {button(t("onboarding.connectedCta"), advance)}
        </>
      )}
      {step === "models" && (
        <>
          <div className="flex w-full flex-col gap-3">
            {["abacus", "openrouter", "gemini"].map((provider) => (
              <div
                key={provider}
                className="bg-muted flex items-center justify-between rounded-xl border p-4"
              >
                <span>{t(`onboarding.pages.models.${provider}`)}</span>
                {connected.has(provider) ||
                (provider === "abacus" && facts.signedIn) ? (
                  <Badge>{t("onboarding.pages.connectedLabel")}</Badge>
                ) : provider === "gemini" ? (
                  props.addKey
                ) : (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      provider === "abacus"
                        ? props.signIn("signin")
                        : void perform(async () => {
                            await transport.client.auth.openRouter.start({});
                            await models.refetch();
                            await keys.refetch();
                          })
                    }
                  >
                    {t("onboarding.pages.connectLabel")}
                  </Button>
                )}
              </div>
            ))}
            {props.localModel}
          </div>
          <div className="w-full rounded-xl border p-4">
            <h2>{t("onboarding.setupExistingTitle")}</h2>
            <p>{t("onboarding.setupExistingBody")}</p>
            <Button variant="ghost" onClick={advance}>
              {t("onboarding.setupExistingLater")}
            </Button>
          </div>
          {button(t("onboarding.setupDoneCta"), advance)}
        </>
      )}
      {step === "connectors" && (
        <>
          <div className="grid w-full grid-cols-3 gap-3">
            {CONNECTORS.filter(
              (c) => c.onboarding || (more && c.kind === "platform")
            )
              .filter((c) => statuses.data?.[c.id]?.reason !== "not-offered")
              .map((c) => (
                <div
                  key={c.id}
                  className="bg-muted flex flex-col items-center gap-3 rounded-xl border p-4"
                >
                  <ConnectorMark
                    id={
                      (
                        {
                          "google-drive": "drive",
                          "google-calendar": "calendar",
                        } as Record<string, string>
                      )[c.logo ?? ""] ??
                      c.logo ??
                      c.id
                    }
                    initial={c.name.slice(0, 1)}
                    size={28}
                  />
                  <span>{c.name}</span>
                  {statuses.data?.[c.id]?.state === "connected" ? (
                    <Badge>{t("onboarding.pages.connectedLabel")}</Badge>
                  ) : (
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await props.connect?.(c.id);
                          await statuses.refetch();
                        })
                      }
                    >
                      {prefs.onboardingPairing?.includes(
                        c.id.replace("messaging-", "") as never
                      )
                        ? t("onboarding.pages.deferred")
                        : t("onboarding.pages.connectLabel")}
                    </Button>
                  )}
                </div>
              ))}
          </div>
          <Button variant="ghost" onClick={() => setMore(!more)}>
            {t("onboarding.pages.more")}
          </Button>
          {button(t("onboarding.connectorsContinue"), advance)}
        </>
      )}
      {step === "first-bot" && (
        <>
          {first.state === "pending" && <Spinner />}
          {first.state === "removed" && (
            <>
              <p>{t("onboarding.pages.removed")}</p>
              {button(t("onboarding.connectorsContinue"), () =>
                props.navigate("done")
              )}
            </>
          )}
          {bot && (
            <>
              <div className="bg-muted w-full rounded-xl border p-5">
                <h2>
                  {bots?.some((b) => b.id === bot.id)
                    ? bot.name
                    : t("onboarding.pages.removed")}
                </h2>
                <p>
                  {t(
                    first.state === "ready" && first.result.checkInRoutineId
                      ? "onboarding.pages.checkIn"
                      : "onboarding.pages.noCheckIn"
                  )}
                </p>
              </div>
              {button(
                t("onboarding.pages.hello"),
                () =>
                  void perform(async () => {
                    await transport.client.system.funnelStep({
                      step: "first_bot_kept",
                    });
                    await props.navigate("done");
                  })
              )}
              {button(
                t("tour.replay"),
                () =>
                  void perform(async () => {
                    await transport.client.system.funnelStep({
                      step: "first_bot_kept",
                    });
                    await props.complete({ to: "bot-tour", botId: bot.id });
                  }),
                true
              )}
              <Button
                variant="ghost"
                onClick={() =>
                  void perform(() =>
                    props.complete({ to: "bot", botId: bot.id, edit: true })
                  )
                }
              >
                {t("mcpManagement.edit")}
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  void perform(async () => {
                    if (first.state !== "ready") return;
                    await discardFirstBot(db, first.result);
                    await transport.client.system.funnelStep({
                      step: "first_bot_cancelled",
                    });
                    await props.navigate("done");
                  })
                }
              >
                {t("onboarding.pages.scratch")}
              </Button>
            </>
          )}
        </>
      )}
      {step === "done" && (
        <>
          {button(
            bot
              ? t("onboarding.pages.message", { name: bot.name })
              : t("onboarding.pages.newBot"),
            () =>
              void perform(() =>
                props.complete(
                  bot ? { to: "bot", botId: bot.id } : { to: "new-bot" }
                )
              )
          )}
          {button(
            t("onboarding.pages.newSession"),
            () => void perform(() => props.complete({ to: "new-session" })),
            true
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
};

export { PairingQueueBanner } from "./pairing-banner";
export { OnboardingLocalModels } from "./steps/local-models";
export { OnboardingProviderKey } from "./steps/provider-key";
export { OnboardingGallery } from "./gallery";
export { enterStep, type OnboardingExit } from "./actions";

export { connectOnboarding } from "./connect";
