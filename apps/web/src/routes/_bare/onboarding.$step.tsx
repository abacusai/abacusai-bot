import { connectorById } from "@abacus-ai/connectors/registry";
import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
import { isPayingAbacusTier } from "@abacus-ai/contract/models";
import { canSignOutOfAbacus } from "@abacus-ai/contract/settings";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { OnboardingLocalModels } from "#platform/local-models";
import { createBotFromTemplate } from "#renderer/features/bots/data/bot-actions";
import { MessagingPlatformDialog } from "#renderer/features/library/messaging";
import { OnboardingStepPage } from "#renderer/features/onboarding";
import { completeOnboarding } from "#renderer/features/onboarding/actions";
import {
  enterStep,
  type OnboardingExit,
} from "#renderer/features/onboarding/actions";
import {
  cancelOnboardingConnect,
  connectOnboarding,
} from "#renderer/features/onboarding/connect";
import { previewFirstBot } from "#renderer/features/onboarding/first-bot";
import {
  startFirstRunGmail,
  startWebsiteSignIn,
} from "#renderer/features/onboarding/first-run";
import {
  guardStep,
  onboardingExitTarget,
  type FlowFacts,
} from "#renderer/features/onboarding/machine";
import {
  onboardingStore,
  startSignIn,
  cancelSignIn,
} from "#renderer/features/onboarding/store";
import { startTour } from "#renderer/features/tour/store";
import {
  ONBOARDING_STEPS,
  type OnboardingStepId,
} from "#renderer/lib/navigation/areas";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
const OnboardingRoute = () => {
  const { t } = useTranslation();
  const step = Route.useParams().step as OnboardingStepId;
  const { facts } = Route.useLoaderData();
  const { transport, db, queryClient } = Route.useRouteContext();
  const [pairing, setPairing] = useState<{
    id: string;
    platform: MessagingPlatformId;
  } | null>(null);
  const router = useRouter();
  const navigate = useAppNavigate();
  const go = (step: OnboardingStepId) =>
    navigate({
      to: "/onboarding/$step",
      params: { step },
      replace: true,
      transition: "none",
    });
  const navigateStep = (target: OnboardingStepId) => {
    // The URL can change before the outgoing step and its key handler unmount.
    if (router.state.location.pathname !== `/onboarding/${step}`)
      return Promise.resolve();
    return go(target);
  };
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
        void transport.client.auth.openRouter.cancel({}).catch(() => undefined);
        void cancelSignIn(transport).catch(() => undefined);
      }
      if (step === "connectors") cancelOnboardingConnect();
    };
  }, [db, transport, step]);
  const auth = (intent: "signup" | "signin", profileId?: string) => {
    if (
      startSignIn(transport, intent, profileId, async (outcome) => {
        if (step === "models") {
          void queryClient.invalidateQueries();
          return;
        }
        if (outcome.ok) {
          const account = await transport.client.account.abacus({
            refresh: true,
          });
          await startFirstRunGmail(transport, account?.email ?? "");
          await queryClient.invalidateQueries();
          void go("connected");
        } else if (outcome.cancelled) void go("welcome");
      }) &&
      step !== "models"
    )
      void go("connect");
  };
  const finish = (exit: OnboardingExit, createDefaultBot = false) =>
    completeOnboarding(
      {
        db,
        transport,
        queryClient,
        navigate: async (exit) => {
          await navigate({
            ...onboardingExitTarget(exit),
            replace: true,
            transition: "none",
          });
          if (router.state.isLoading)
            await new Promise<void>((resolve) => {
              const stop = router.subscribe("onResolved", () => {
                stop();
                resolve();
              });
            });
        },
        resolveExit: async (exit) => {
          if (!createDefaultBot && exit.to !== "bot" && exit.to !== "bot-tour")
            return exit;
          try {
            const snapshot = await transport.client.db.bots.snapshot({});
            if (snapshot.rows.some((bot) => bot.channel == null)) {
              await transport.client.system.funnelStep({
                step: "first_bot_skipped",
                detail: "has_bots",
              });
              return exit;
            }
            const { bot } = await createBotFromTemplate(db, "chief-of-staff", {
              name: t("bots.templates.chief-of-staff.name"),
              sponsoredFirstRun: true,
            });
            await transport.client.system.funnelStep({
              step: "first_bot_shown",
            });
            await transport.client.system.funnelStep({
              step: "first_bot_kept",
            });
            return exit.to === "bot" || exit.to === "bot-tour"
              ? { ...exit, botId: bot.id }
              : { to: "bot", botId: bot.id };
          } catch {
            await transport.client.system.funnelStep({
              step: "first_bot_skipped",
              detail: "create_failed",
            });
            return { to: "new-bot" };
          }
        },
        startTour: () =>
          startTour({
            onboarded: true,
          }),
      },
      exit
    );
  const create = async (id: string) =>
    previewFirstBot(id, t("bots.templates.chief-of-staff.name"));
  const automaticallySignIn = useEffectEvent(() => {
    if (onboardingStore.state.signIn?.status !== "pending") auth("signin");
  });
  const completeWebsiteSignup = useEffectEvent(() =>
    finish({ to: "new-bot" }, true)
  );
  useEffect(() => {
    // Nothing is known yet: no sign-in starts, nothing completes.
    if (facts.provisional) return;
    if (step === "welcome" && !facts.signedIn)
      void startWebsiteSignIn(transport, automaticallySignIn).catch(() => {});
    if (facts.signedIn && facts.email)
      void startFirstRunGmail(transport, facts.email).catch(() => {});
    if (facts.signedIn && facts.webSignup && step === "connected")
      void completeWebsiteSignup();
  }, [
    step,
    facts.provisional,
    facts.signedIn,
    facts.email,
    facts.webSignup,
    transport,
  ]);
  const connect = async (id: string) => {
    const entry = connectorById(id);
    if (IS_ELECTRON && entry?.kind === "messaging") {
      setPairing({ id, platform: entry.platform });
      return;
    }
    return connectOnboarding(db, transport, id);
  };
  return (
    <>
      <OnboardingStepPage
        step={step}
        facts={facts}
        transport={transport}
        navigate={navigateStep}
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
      />
      {pairing && step === "connectors" && (
        <MessagingPlatformDialog
          key={pairing.platform}
          platform={pairing.platform}
          onClose={async () => {
            setPairing(null);
            await queryClient.invalidateQueries({
              queryKey: transport.orpc.connectors.statuses.queryKey({
                input: {},
              }),
            });
          }}
          finalFocus={() =>
            document.querySelector<HTMLElement>(
              `[data-connector="${pairing.id}"]`
            )
          }
        />
      )}
    </>
  );
};
/**
 * The facts a step decides on, from the host. Reads with the load's signal:
 * a navigation away cancels them, and they wait for the host as long as
 * the load does (never held as writes).
 */
const factsOf = async (
  context: import("#renderer/router").RouterContext,
  signal: AbortSignal
): Promise<FlowFacts> => {
  const [settings, account] = await Promise.all([
    context.transport.client.settings.get({}, { signal }),
    context.transport.client.account.abacus({}, { signal }),
  ]);
  return {
    signedIn: canSignOutOfAbacus(settings),
    payingTier: isPayingAbacusTier(account?.subscription_tier),
    webSignup: account?.web_signup === true,
    email: account?.email ?? "",
    ownsBot: context.db.collections.bots.toArray.some(
      (bot) => bot.channel == null
    ),
  };
};
/**
 * While onboarding renders provisionally (the browser's host is still
 * connecting, spec 09 D12) nothing is known: the step renders as asked,
 * acts on no fact and redirects nowhere. Once the host answers, the
 * parent's gate re-runs and this route's guard decides from fresh facts.
 */
const UNKNOWN_FACTS: FlowFacts = {
  signedIn: false,
  payingTier: false,
  ownsBot: false,
  provisional: true,
};
export const Route = createFileRoute("/_bare/onboarding/$step")({
  params: { parse: v.parser(v.object({ step: v.picklist(ONBOARDING_STEPS) })) },
  beforeLoad: async ({ context, params, abortController }) => {
    if (context.provisional) return;
    await context.db.collections.bots.preload();
    const facts = await factsOf(context, abortController.signal);
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
  loader: async ({ context, params, cause, abortController }) => {
    if (context.provisional) return { facts: UNKNOWN_FACTS };
    const { signal } = abortController;
    if (cause === "preload") return { facts: await factsOf(context, signal) };
    if (IS_ELECTRON && params.step === "welcome")
      await context.queryClient.ensureQueryData(
        context.transport.orpc.auth.abacus.browserProfiles.queryOptions({
          input: {},
        })
      );
    if (params.step === "connected")
      await context.transport.client.account.abacus(
        { refresh: true },
        { signal }
      );
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
        // A local runtime is optional; the pane presents its unavailable state.
        context.queryClient
          .ensureQueryData(
            context.transport.orpc.localModels.state.queryOptions({ input: {} })
          )
          .catch(() => undefined),
      ]);
    if (params.step === "connectors")
      await context.queryClient.ensureQueryData(
        context.transport.orpc.connectors.statuses.queryOptions({ input: {} })
      );
    if (params.step === "first-bot")
      await context.db.collections.routines.preload();
    return { facts: await factsOf(context, signal) };
  },
  component: OnboardingRoute,
});
