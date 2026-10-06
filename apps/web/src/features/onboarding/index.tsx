import { useLiveQuery } from "@tanstack/react-db";

import "./onboarding.css";
import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { BotAvatar } from "#renderer/components/bot-avatar";
import { useDb } from "#renderer/data/db";
import { resolveLook } from "#renderer/lib/bots/avatar";
import { useSharedElementName } from "#renderer/lib/navigation/shared-element";
import { IS_ELECTRON } from "#renderer/lib/platform";

import { ensureFirstBot, firstBotStore } from "./first-bot";
import { FirstBotHatch } from "./hatch";
import { next, connectedProviders } from "./machine";
import { ConnectStep } from "./steps/connect";
import { ConnectedStep } from "./steps/connected";
import { ConnectorsStep } from "./steps/connectors";
import type { OnboardingPageProps, StepContext } from "./steps/context";
import { DoneStep } from "./steps/done";
import { FirstBotStep } from "./steps/first-bot";
import { ModelsStep } from "./steps/models";
import { WelcomeStep } from "./steps/welcome";
import { onboardingStore } from "./store";

export { OnboardingFrame } from "./frame";
export { onboardingStore } from "./store";
export type { OnboardingPageProps } from "./steps/context";

const Parade = () => (
  <div className="onboarding-stage" aria-hidden="true">
    {["bunny", "blob", "mochi", "cat", "star"].map((shape, i) => (
      <span
        key={shape}
        className="onboarding-bob"
        style={{ animationDelay: `${i * 0.4}s` }}
      >
        <BotAvatar
          look={resolveLook({
            name: shape,
            avatarShape: shape,
            avatarColor: ["pink", "green", "blue", "orange", "yellow"][i]!,
          })}
          size={[56, 72, 88, 72, 56][i]!}
        />
      </span>
    ))}
  </div>
);

export const OnboardingStepPage = (props: OnboardingPageProps) => {
  const { step, transport, facts } = props;
  const { t } = useTranslation();
  const db = useDb();
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
    enabled: IS_ELECTRON && (step === "welcome" || step === "connect"),
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
  const connected = connectedProviders(
    (models.data ?? []).filter((m) => m.configured),
    keys.data ?? []
  );
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  useEffect(() => {
    if (step !== "first-bot" || props.preview || facts.provisional) return;
    ensureFirstBot(facts.ownsBot, props.createFirstBot);
  }, [step, facts.ownsBot, facts.provisional, props]);
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
    if (props.preview || liveFirst.state !== "ready") return;
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
  const go = (event: "next" | "back") => {
    const target = next(step, { type: event }, facts, attempt?.id ?? null);
    if (target !== "ignore" && target !== "complete")
      void props.navigate(target);
  };
  const ctx: StepContext = {
    props,
    t,
    busy,
    perform,
    advance: () => go("next"),
    back: () => go("back"),
  };
  const present =
    (first.state === "ready" && first.result.preview === true) ||
    (bot != null && (bots?.some((b) => b.id === bot.id) ?? false));
  // The browser arrives signed in to the website: its welcome is the account
  // hand-off starting (first-run.ts), never the desktop's sign-up wall.
  const webWelcome = step === "welcome" && !IS_ELECTRON;
  return (
    <section className="onboarding-step" data-onboarding-step={step}>
      {(step === "welcome" && !webWelcome) || (step === "done" && !bot) ? (
        <Parade />
      ) : step === "models" || step === "connectors" ? null : (
        <div
          className={step === "first-bot" ? "relative mb-6" : "mb-6"}
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
                avatarShape: bot?.avatarShape ?? "blob",
                avatarColor: bot?.avatarColor ?? "#4ade80",
              })}
              size={96}
              mood={step === "connect" || webWelcome ? "waiting" : "idle"}
            />
          )}
        </div>
      )}
      {step === "welcome" && (
        <WelcomeStep ctx={ctx} profiles={profiles.data} heading={heading} />
      )}
      {step === "connect" && (
        <ConnectStep
          ctx={ctx}
          attempt={attempt}
          profiles={profiles.data}
          heading={heading}
        />
      )}
      {step === "connected" && <ConnectedStep ctx={ctx} heading={heading} />}
      {step === "models" && (
        <ModelsStep
          ctx={ctx}
          connected={connected}
          refresh={() => Promise.all([models.refetch(), keys.refetch()])}
          heading={heading}
        />
      )}
      {step === "connectors" && (
        <ConnectorsStep
          ctx={ctx}
          statuses={statuses.data}
          refresh={() => statuses.refetch()}
          more={more}
          setMore={setMore}
          heading={heading}
        />
      )}
      {step === "first-bot" && (
        <FirstBotStep
          ctx={ctx}
          first={first}
          bot={bot}
          present={present}
          heading={heading}
        />
      )}
      {step === "done" && (
        <DoneStep
          ctx={ctx}
          bot={bot}
          checkIn={
            first.state === "ready" && first.result.checkInRoutineId != null
          }
          heading={heading}
        />
      )}
      {error && (
        <p role="alert" className="onboarding-quiet mt-4">
          {error}
        </p>
      )}
    </section>
  );
};

export { type OnboardingExit } from "./actions";
