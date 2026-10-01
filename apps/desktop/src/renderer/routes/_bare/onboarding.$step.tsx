import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import * as v from "valibot";

import { createBotFromTemplate } from "#renderer/features/bots";
import {
  OnboardingStepPage,
  connectOnboarding,
  completeOnboarding,
  guardStep,
  onboardingStore,
  startSignIn,
  cancelSignIn,
} from "#renderer/features/onboarding";
import { enterStep, type OnboardingExit } from "#renderer/features/onboarding";
import { OnboardingLocalModels } from "#renderer/features/onboarding";
import { OnboardingProviderKey } from "#renderer/features/onboarding";
import { startTour } from "#renderer/features/tour";
import {
  ONBOARDING_STEPS,
  type OnboardingStepId,
} from "#renderer/lib/navigation/areas";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { isPayingAbacusTier } from "#shared/models";
import { canSignOutOfAbacus } from "#shared/settings";
const OnboardingRoute = () => {
  const step = Route.useParams().step as OnboardingStepId;
  const { facts } = Route.useLoaderData();
  const { transport, db, queryClient } = Route.useRouteContext();
  const router = useRouter();
  const navigate = useAppNavigate();
  const go = (step: OnboardingStepId) =>
    navigate({
      to: "/onboarding/$step",
      params: { step },
      replace: true,
      transition: "onboarding-step",
    });
  const entered = useRef<OnboardingStepId | null>(null);
  useEffect(() => {
    if (entered.current !== step) {
      entered.current = step;
      void enterStep(db, transport, step).catch((error) => {
        entered.current = null;
        console.warn("[onboarding] enter failed", error);
      });
    }
    return () => {
      if (step === "models") {
        void transport.client.auth.openRouter.cancel({});
        void cancelSignIn(transport);
      }
      if (step === "connectors")
        void transport.client.connectors.cancelConnect({});
    };
  }, [db, transport, step]);
  const auth = (intent: "signup" | "signin", profileId?: string) => {
    if (
      startSignIn(transport, intent, profileId, (outcome) => {
        if (step === "models") {
          void queryClient.invalidateQueries();
          return;
        }
        if (outcome.ok) {
          void queryClient.invalidateQueries();
          void go("connected");
        } else if (outcome.cancelled) void go("welcome");
      }) &&
      step !== "models"
    )
      void go("connect");
  };
  const finish = (exit: OnboardingExit) =>
    completeOnboarding(
      {
        db,
        transport,
        queryClient,
        navigate: async (exit) => {
          if (exit.to === "new-session")
            await navigate({
              to: "/sessions/new",
              replace: true,
              transition: "onboarding-finish",
            });
          else if (exit.to === "new-bot")
            await navigate({
              to: "/bots/new",
              replace: true,
              transition: "onboarding-finish",
            });
          else
            await navigate({
              to:
                exit.to === "bot" && exit.edit
                  ? "/bots/$botId/edit"
                  : "/bots/$botId",
              params: { botId: exit.botId },
              replace: true,
              transition: "onboarding-finish",
            });
          if (router.state.isLoading)
            await new Promise<void>((resolve) => {
              const stop = router.subscribe("onResolved", () => {
                stop();
                resolve();
              });
            });
        },
        startTour: () =>
          startTour({ origin: router.state.location.href, onboarded: true }),
      },
      exit
    );
  const create = (id: string) =>
    createBotFromTemplate(db, "chief-of-staff", {
      id,
      checkIn: { preset: "weekdays", time: "08:00" },
    });
  const connect = (id: string) => connectOnboarding(db, transport, id);
  return (
    <OnboardingStepPage
      step={step}
      facts={facts}
      transport={transport}
      navigate={go}
      signIn={auth}
      cancelSignIn={() => cancelSignIn(transport)}
      complete={finish}
      createFirstBot={create}
      connect={connect}
      localModel={
        <OnboardingLocalModels
          transport={transport}
          saved={() => queryClient.invalidateQueries()}
        />
      }
      addKey={
        <OnboardingProviderKey
          transport={transport}
          saved={() => queryClient.invalidateQueries()}
        />
      }
    />
  );
};
const factsOf = async (context: import("#renderer/router").RouterContext) => {
  const [settings, account] = await Promise.all([
    context.transport.client.settings.get({}),
    context.transport.client.account.abacus({}),
  ]);
  return {
    signedIn: canSignOutOfAbacus(settings),
    payingTier: isPayingAbacusTier(account?.subscription_tier),
    ownsBot: context.db.collections.bots.toArray.some(
      (bot) => bot.channel == null
    ),
  };
};
export const Route = createFileRoute("/_bare/onboarding/$step")({
  params: { parse: v.parser(v.object({ step: v.picklist(ONBOARDING_STEPS) })) },
  beforeLoad: async ({ context, params }) => {
    await context.db.collections.bots.preload();
    const facts = await factsOf(context);
    const guarded = guardStep(
      params.step as OnboardingStepId,
      facts,
      onboardingStore.state
    );
    if (guarded !== params.step)
      throw redirect({
        to: "/onboarding/$step",
        params: { step: guarded },
        replace: true,
      });
  },
  loader: async ({ context, params, cause }) => {
    if (cause === "preload") return { facts: await factsOf(context) };
    if (params.step === "welcome")
      await context.queryClient.ensureQueryData(
        context.transport.orpc.auth.abacus.browserProfiles.queryOptions({
          input: {},
        })
      );
    if (params.step === "connected")
      await context.transport.client.account.abacus({ refresh: true });
    if (params.step === "models")
      await Promise.all([
        context.queryClient.ensureQueryData(
          context.transport.orpc.settings.keys.listProviders.queryOptions({
            input: {},
          })
        ),
        context.queryClient.ensureQueryData(
          context.transport.orpc.models.list.queryOptions({ input: {} })
        ),
        context.queryClient.ensureQueryData(
          context.transport.orpc.localModels.state.queryOptions({ input: {} })
        ),
      ]);
    if (params.step === "connectors")
      await context.queryClient.ensureQueryData(
        context.transport.orpc.connectors.statuses.queryOptions({ input: {} })
      );
    if (params.step === "first-bot")
      await context.db.collections.routines.preload();
    return { facts: await factsOf(context) };
  },
  component: OnboardingRoute,
});
