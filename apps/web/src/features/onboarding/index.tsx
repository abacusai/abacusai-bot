import { CONNECTORS } from "@abacus-ai/connectors/registry";
import { useLiveQuery } from "@tanstack/react-db";

import "./onboarding.css";
import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { BotAvatar } from "#renderer/components/bot-avatar";
import { ConnectorMark } from "#renderer/components/connector-mark";
import { Spinner } from "#renderer/components/spinner";
import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import type { Transport } from "#renderer/data/transport";
import { resolveLook } from "#renderer/lib/bots/avatar";
import { useMotionPreference } from "#renderer/lib/motion";
import type { OnboardingStepId } from "#renderer/lib/navigation/areas";
import { useSharedElementName } from "#renderer/lib/navigation/shared-element";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { signInFailureCopy } from "#renderer/lib/sign-in-failure";
import { Badge } from "#renderer/ui/badge";
import { Button } from "#renderer/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
} from "#renderer/ui/dropdown-menu";

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

export { onboardingStore } from "./store";
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
    enabled: IS_ELECTRON && step === "welcome",
  });
  const refetchProfiles = profiles.refetch;
  useEffect(() => {
    if (!IS_ELECTRON || step !== "welcome") return;
    const focus = () => {
      void refetchProfiles();
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [step, refetchProfiles]);
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
  const quickProfile = profiles.data?.find(
    (profile) => profile.isDefault && profile.hasAbacusSession === true
  );
  const sessionProfiles =
    profiles.data?.filter((profile) => profile.hasAbacusSession !== false) ??
    [];
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
      !liveFirst.result.preview &&
      bots &&
      !bots.some((item) => item.id === liveFirst.result.bot.id)
    ) {
      firstBotStore.setState(() => ({ state: "removed" }));
    }
  }, [bots, liveFirst, props.preview]);
  const shownBot = useRef<string | null>(null);
  useEffect(() => {
    if (step !== "first-bot") {
      shownBot.current = null;
      return;
    }
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
  const button = (label: string, action: () => void, secondary = false) => (
    <Button
      size="lg"
      className={
        secondary
          ? "h-10 rounded-xl px-5"
          : "onboarding-continue h-11 rounded-xl px-6"
      }
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
          : step === "connect" && !IS_ELECTRON
            ? t("onboarding.webSignIn.body")
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
          {quickProfile ? (
            button(
              t("onboarding.haveAccountCta"),
              () => props.signIn("signin", quickProfile.id),
              true
            )
          ) : sessionProfiles.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button size="lg" variant="secondary" disabled={busy} />
                }
              >
                {t("onboarding.haveAccountCta")}
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuGroup>
                  {sessionProfiles.map((profile) => (
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
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            button(
              t("onboarding.haveAccountCta"),
              () => props.signIn("signin"),
              true
            )
          )}
          {defaultProfile && (
            <p>
              {t("onboarding.usesBrowserSessions", {
                browser: defaultProfile.browserName,
              })}
            </p>
          )}
        </>
      )}
      {step === "connect" && (
        <>
          {((props.preview && !attempt) || attempt?.status === "pending") && (
            <div role="status" className="flex items-center gap-2">
              <Spinner />
              {t(
                IS_ELECTRON
                  ? "onboarding.pages.connect.waiting"
                  : "onboarding.webSignIn.waiting"
              )}
            </div>
          )}
          {attempt?.status === "failed" && (
            <p role="alert">
              {t(
                attempt.outcome &&
                  !attempt.outcome.ok &&
                  attempt.outcome.error === "unidentified-account"
                  ? "onboarding.abacusUnidentified"
                  : !IS_ELECTRON && attempt.outcome && !attempt.outcome.ok
                    ? signInFailureCopy(attempt.outcome.error).key
                    : "onboarding.frame.failed",
                !IS_ELECTRON && attempt.outcome && !attempt.outcome.ok
                  ? { code: signInFailureCopy(attempt.outcome.error).code }
                  : {}
              )}
            </p>
          )}
          {attempt?.status === "failed" &&
            button(t("onboarding.pages.retry"), () =>
              props.signIn(attempt.intent, attempt.profileId)
            )}
          {IS_ELECTRON && (
            <Button
              variant="default"
              onClick={() =>
                void transport.client.auth.abacus.openInBrowser({})
              }
            >
              {t("onboarding.openInBrowserCta")}
            </Button>
          )}
          {IS_ELECTRON ? (
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
          ) : attempt?.status === "failed" &&
            attempt.outcome &&
            !attempt.outcome.ok &&
            attempt.outcome.error === "auth-code:session:UNKNOWN" ? (
            <a
              href={`/chatllm/signin?redirectUrl=${encodeURIComponent("/bot/" + location.hash)}`}
            >
              {t("onboarding.signInAnotherWay")}
            </a>
          ) : null}

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
          <ul className="bg-card w-full space-y-3 rounded-xl border p-5 text-left text-sm">
            {[1, 2, 3, 4].map((n) => (
              <li key={n} className="flex gap-3">
                <span aria-hidden>✓</span>
                <span>{t(`onboarding.pages.connected.promise${n}`)}</span>
              </li>
            ))}
          </ul>
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
                  IS_ELECTRON && (
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
                  )
                )}
              </div>
            ))}
            {props.localModel}
          </div>
          <p className="text-sm">{t("onboarding.setupExistingBody")}</p>
          {button(t("onboarding.setupDoneCta"), advance)}
        </>
      )}
      {step === "connectors" && (
        <>
          <div className="grid w-full grid-cols-2 gap-3 sm:grid-cols-4">
            {CONNECTORS.filter(
              (c) => c.onboarding || (more && c.kind === "platform")
            )
              .filter((c) => IS_ELECTRON || c.kind !== "messaging")
              .filter((c) => statuses.data?.[c.id]?.reason !== "not-offered")
              .map((c) => (
                <div
                  key={c.id}
                  className="bg-card flex min-h-32 flex-col items-center gap-3 rounded-xl border p-4 [&>span:not([data-slot])]:flex-1 [&>span:not([data-slot])]:content-center"
                >
                  <ConnectorMark
                    id={c.logo ?? c.id}
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
          {button(t("onboarding.connectorsContinue"), () => {
            if (!facts.ownsBot)
              void perform(() => props.complete({ to: "new-bot" }));
            else advance();
          })}
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
                  {(first.state === "ready" && first.result.preview) ||
                  bots?.some((b) => b.id === bot.id)
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

export { type OnboardingExit } from "./actions";
