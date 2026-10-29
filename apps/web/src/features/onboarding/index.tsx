import { useLiveQuery } from "@tanstack/react-db";

import "./onboarding.css";
import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  PaymentRequiredPanel,
  usePaymentRequired,
} from "#renderer/components/payment-required";
import { useDb } from "#renderer/data/db";
import { connectErrorText } from "#renderer/lib/connect-page";
import type { OnboardingStepId } from "#renderer/lib/navigation/areas";

import { ConnectFailed } from "./connect";
import {
  ensureFirstBot,
  firstBotStore,
  inboxPassStore,
  type FirstBotState,
} from "./first-bot";
import { OnboardingNavigation } from "./frame";
import { next, connectedProviders } from "./machine";
import { ConnectStep } from "./steps/connect";
import { ConnectedStep } from "./steps/connected";
import { ConnectorsStep } from "./steps/connectors";
import type { OnboardingPageProps, StepContext } from "./steps/context";
import { DoneStep } from "./steps/done";
import { FirstBotStep } from "./steps/first-bot";
import { StepTitle } from "./steps/kit";
import { ModelsStep } from "./steps/models";
import { OfferStep } from "./steps/offer";
import { WelcomeStep } from "./steps/welcome";
import { onboardingStore } from "./store";
import { useFinalHandoff } from "./use-final-handoff";

export { OnboardingFrame } from "./frame";
export { onboardingStore } from "./store";
export type { OnboardingPageProps } from "./steps/context";

/** A control handles its own Enter; text fields keep theirs. */
const isKeyboardTarget = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  if (element == null || typeof element.closest !== "function") return false;
  return (
    element.closest(
      'button, a, input, textarea, select, [contenteditable], [role="menuitem"]'
    ) != null
  );
};

/** The step's primary action for Enter (null: nothing to continue with). */
export const primaryAction = (
  step: OnboardingStepId,
  actions: {
    signIn(intent: "signup"): void;
    advance(): void;
    continueConnectors(): void;
    hello: (() => void) | null;
    finish(): void;
    retry: (() => void) | null;
  }
): (() => void) | null => {
  switch (step) {
    case "welcome":
      return () => actions.signIn("signup");
    case "connect":
      return actions.retry;
    case "connected":
    case "models":
      return actions.advance;
    case "connectors":
      return actions.continueConnectors;
    // Neither answer is the default: Enter picks no side of the offer.
    case "offer":
      return null;
    case "first-bot":
      return actions.hello;
    case "done":
      return actions.finish;
  }
};

export const OnboardingStepPage = (props: OnboardingPageProps) => {
  const { step, transport, facts } = props;
  const { t } = useTranslation();
  const db = useDb();
  const liveFirst = useSelector(firstBotStore, (s) => s);
  const liveInbox = useSelector(inboxPassStore, (s) => s);
  const liveChatApp = useSelector(onboardingStore, (s) => s.chatApp ?? null);
  const preview = props.previewFirstRun;
  const first: FirstBotState =
    step === "first-bot" && preview != null && preview.inbox == null
      ? { state: "choose" }
      : props.previewBot
        ? { state: "ready", result: props.previewBot }
        : liveFirst;
  const inbox = preview?.inbox ?? liveInbox;
  const chatApp = preview != null ? (preview.chatApp ?? null) : liveChatApp;
  const attempt = useSelector(onboardingStore, (s) => s.signIn);
  const payment = usePaymentRequired(
    !props.preview && (step === "welcome" || step === "connect")
  );
  // Signed in, but the account must pay first: its screen, never the sign-in again.
  const paymentShown =
    !props.preview &&
    (step === "welcome" || step === "connect") &&
    (payment.data != null ||
      (attempt?.status === "failed" &&
        attempt.outcome?.ok === false &&
        attempt.outcome.error === "payment-required"));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const bot = first.state === "ready" ? first.result.bot : null;
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
    if (props.preview) return;
    if (liveFirst.state !== "ready" && liveFirst.state !== "choose") return;
    const id = liveFirst.state === "ready" ? liveFirst.result.bot.id : "choose";
    if (shownBot.current === id) return;
    shownBot.current = id;
    void transport.client.system.funnelStep({ step: "first_bot_shown" });
    if (liveFirst.state === "ready")
      void transport.client.system.funnelStep({ step: "screen_b_shown" });
  }, [step, liveFirst, transport, props.preview]);
  const performing = useRef(false);
  const perform = async (action: () => Promise<unknown>) => {
    if (performing.current) return;
    performing.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (error) {
      setError(
        error instanceof ConnectFailed
          ? connectErrorText(t, error.message)
          : t("onboarding.frame.failed")
      );
    }
    performing.current = false;
    setBusy(false);
  };
  const go = (event: "next" | "back") => {
    const result = next(step, { type: event }, facts, attempt?.id ?? null);
    const target =
      event === "back" && result === "ignore"
        ? step === "connected"
          ? "welcome"
          : step === "first-bot"
            ? "connectors"
            : step === "done"
              ? bot
                ? "first-bot"
                : "connectors"
              : result
        : result;
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
  const existingBot = bots?.[0];
  // A ready bot waits for the person's pick (its chat, or building); only an
  // account that already has a bot moves on by itself.
  useFinalHandoff(
    !props.preview &&
      !facts.provisional &&
      step === "first-bot" &&
      first.state === "skipped" &&
      first.reason !== "create_failed" &&
      bots != null,
    () => {
      if (performing.current) return;
      void perform(async () => {
        if (first.state === "skipped" && first.reason === "has_bots")
          await transport.client.system.funnelStep({
            step: "first_bot_skipped",
            detail: "has_bots",
          });
        const target = bot ?? existingBot;
        await props.complete(
          target ? { to: "bot", botId: target.id } : { to: "new-bot" }
        );
      });
    }
  );
  /** Enter continues with the step's primary action; Escape goes back where the flow allows. */
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      busy ||
      isKeyboardTarget(event.target) ||
      paymentShown ||
      document.querySelector('[role="dialog"], [role="menu"]') != null
    )
      return;
    if (event.key === "Enter" || event.key === "ArrowRight") {
      const primary = primaryAction(step, {
        signIn: props.signIn,
        advance: () => go("next"),
        continueConnectors: () => go("next"),
        hello: bot
          ? () =>
              void perform(() => props.choose({ kind: "bot", botId: bot.id }))
          : first.state === "choose"
            ? () =>
                void perform(async () => {
                  await transport.client.system.funnelStep({
                    step: "first_choice_build",
                    detail: "enter",
                  });
                  await props.choose({ kind: "build", prompt: null });
                })
            : first.state === "skipped" || first.state === "removed"
              ? () => void perform(() => props.complete({ to: "new-bot" }))
              : null,
        finish: () =>
          void perform(() =>
            props.complete(
              bot ? { to: "bot", botId: bot.id } : { to: "new-bot" }
            )
          ),
        retry:
          attempt?.status === "failed"
            ? () => props.signIn(attempt.intent)
            : null,
      });
      if (primary) {
        event.preventDefault();
        primary();
      }
    } else if (event.key === "Escape" || event.key === "ArrowLeft") {
      if (step === "connect") {
        event.preventDefault();
        void perform(async () => {
          await props.cancelSignIn();
          await props.navigate("welcome");
        });
      } else if (step !== "welcome") {
        event.preventDefault();
        go("back");
      }
    }
  });
  useEffect(() => {
    if (props.preview) return;
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.preview]);
  const present =
    (first.state === "ready" && first.result.preview === true) ||
    (bot != null && (bots?.some((b) => b.id === bot.id) ?? false));
  return (
    <section className="onboarding-step" data-onboarding-step={step}>
      <OnboardingNavigation
        onBack={
          step === "welcome"
            ? undefined
            : () => {
                if (step === "connect")
                  void perform(async () => {
                    await props.cancelSignIn();
                    await props.navigate("welcome");
                  });
                else go("back");
              }
        }
      />
      {paymentShown && (
        <PaymentRequiredPanel
          payment={payment.data ?? null}
          title={(text) => (
            <StepTitle ref={heading} size="medium">
              {text}
            </StepTitle>
          )}
          onSignedIn={() => props.navigate("connected")}
          onSignedOut={async () => {
            await props.cancelSignIn();
            await props.navigate("welcome");
          }}
        />
      )}
      {!paymentShown && step === "welcome" && (
        <WelcomeStep ctx={ctx} heading={heading} />
      )}
      {!paymentShown && step === "connect" && (
        <ConnectStep ctx={ctx} attempt={attempt} heading={heading} />
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
          loading={statuses.isPending}
          refresh={() => statuses.refetch()}
          heading={heading}
        />
      )}
      {step === "offer" && <OfferStep ctx={ctx} heading={heading} />}
      {step === "first-bot" && first.state !== "skipped" && (
        <FirstBotStep
          ctx={ctx}
          first={first}
          bot={bot}
          present={present}
          heading={heading}
          inbox={inbox}
          chatApp={chatApp}
        />
      )}
      {(step === "done" ||
        (step === "first-bot" && first.state === "skipped")) && (
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
