import { connectorById } from "@abacus-ai/connectors/registry";
import {
  isMessagingPlatformConnected,
  type MessagingPlatformId,
} from "@abacus-ai/contract/messaging";
import { isPayingAbacusTier } from "@abacus-ai/contract/models";
import { canSignOutOfAbacus } from "@abacus-ai/contract/settings";
import { abacusAgentPromptUrl } from "@abacus-ai/contract/toolsets";
import { isCancelledError } from "@tanstack/react-query";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import {
  createBotFromTemplate,
  createGoalBot,
} from "#renderer/features/bots/data/bot-actions";
import { openChatOnce } from "#renderer/features/bots/data/open-chat";
import { MessagingPlatformDialog } from "#renderer/features/library/messaging";
import { OnboardingStepPage } from "#renderer/features/onboarding";
import { completeOnboarding } from "#renderer/features/onboarding/actions";
import {
  enterStep,
  type OnboardingExit,
} from "#renderer/features/onboarding/actions";
import {
  releaseOnboardingConnect,
  connectOnboarding,
} from "#renderer/features/onboarding/connect";
import {
  chatAppTemplateId,
  firstBotStore,
  noteConnectedChatApp,
  RESEARCH_GOAL,
  watchInboxPass,
  type FirstChoice,
} from "#renderer/features/onboarding/first-bot";
import { startWebsiteSignIn } from "#renderer/features/onboarding/first-run";
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
import {
  queueStartPrompt,
  startBuildDraft,
} from "#renderer/features/sessions/start/start-session";
import { startTour } from "#renderer/features/tour/store";
import { UpgradeDialogHost } from "#renderer/features/upgrade-dialog";
import { BUILD_STARTER_IDS } from "#renderer/lib/build-starters";
import {
  ONBOARDING_STEPS,
  type OnboardingStepId,
} from "#renderer/lib/navigation/areas";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
import { requestPlanDialog } from "#renderer/lib/upgrade-dialog";
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
      if (step === "connectors") releaseOnboardingConnect();
    };
  }, [db, transport, step]);
  const auth = (intent: "signup" | "signin") => {
    if (
      startSignIn(transport, intent, async (outcome) => {
        const attemptId = onboardingStore.state.signIn?.id;
        if (step === "models") {
          void queryClient.invalidateQueries();
          return;
        }
        if (outcome.ok) {
          await transport.client.account.abacus({ refresh: true });
          if (onboardingStore.state.signIn?.id !== attemptId) return;
          await queryClient.invalidateQueries();
          if (onboardingStore.state.signIn?.id !== attemptId) return;
          await go("connected");
        } else if (outcome.cancelled) await go("welcome");
        // Held for payment: the screen reads why from the host.
        else if (outcome.error === "payment-required")
          await queryClient.invalidateQueries({
            queryKey: transport.orpc.account.payment.key(),
          });
      }) &&
      step !== "models"
    )
      void go("connect");
  };
  const finish = (exit: OnboardingExit, tour = false) =>
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
          if (tour) startTour({ onboarded: true });
        },
        startTour: () =>
          startTour({
            onboarded: true,
          }),
      },
      exit
    );
  // After a Gmail sign-in the Chief of Staff starts on the inbox at once, on
  // the house, and the screen shows what it found; else the person picks.
  const create = async (id: string) => {
    const statuses = await transport.client.connectors
      .statuses({})
      .catch(() => null);
    if (statuses?.["abacus-gmailuser"]?.state !== "connected") return null;
    try {
      const { bot } = await createBotFromTemplate(db, "chief-of-staff", {
        id,
        name: t("bots.templates.chief-of-staff.name"),
        sponsoredFirstRun: true,
      });
      watchInboxPass(
        transport,
        openChatOnce({ transport, sessions: db.collections.sessions }, bot)
      );
      return { bot, checkInRoutineId: null };
    } catch (error) {
      await transport.client.system.funnelStep({
        step: "first_bot_skipped",
        detail: "create_failed",
      });
      throw error;
    }
  };
  /** The first thing a pick makes runs on the house; after a Chief of Staff it is already spent. */
  const choose = async (choice: FirstChoice) => {
    const sponsored = firstBotStore.state.state === "choose";
    const open = async (botId: string) => {
      await transport.client.system.funnelStep({ step: "first_bot_kept" });
      await finish({ to: "bot", botId });
    };
    // One id per screen: a pick retried after a failed completion opens the
    // bot it already made instead of making another.
    const id = onboardingStore.state.createdBotId ?? undefined;
    const made = id != null ? db.collections.bots.get(id) : undefined;
    if (made != null && choice.kind !== "build" && choice.kind !== "images") {
      await open(made.id);
      return;
    }
    switch (choice.kind) {
      case "build": {
        // An example sends at once; the card itself leaves the first one in
        // the box to edit or send, the others a tap away under it.
        const draftId = startBuildDraft(
          sponsored,
          choice.prompt == null
            ? t(`sessions.start.build.${BUILD_STARTER_IDS[0]}.prompt`)
            : undefined
        );
        if (choice.prompt != null) queueStartPrompt(draftId, choice.prompt);
        await finish({ to: "new-session" });
        return;
      }
      case "chat-app": {
        const templateId = chatAppTemplateId(choice.app);
        const { bot } = await createBotFromTemplate(db, templateId, {
          ...(id != null ? { id } : {}),
          name: t(`bots.templates.${templateId}.name`),
          ...(sponsored ? { sponsoredFirstRun: true } : {}),
        });
        await open(bot.id);
        return;
      }
      case "research":
      case "goal": {
        const bot = await createGoalBot(db, {
          ...(id != null ? { id } : {}),
          name: t(
            choice.kind === "research"
              ? "onboarding.firstRun.research.botName"
              : "onboarding.firstRun.goal.botName"
          ),
          goal: choice.kind === "research" ? RESEARCH_GOAL : choice.goal,
          sponsoredFirstRun: sponsored,
        });
        await open(bot.id);
        return;
      }
      case "images":
        // The upgrade dialog with the plan's whole pitch on a free account;
        // Abacus AI Agent on a paid one, as the media card does.
        if (facts.payingTier)
          await platformSystem(transport.client).openExternal({
            url: abacusAgentPromptUrl(),
          });
        else requestPlanDialog("onboarding");
        return;
      case "bot":
        await open(choice.botId);
        return;
    }
  };
  const automaticallySignIn = useEffectEvent(() => {
    if (onboardingStore.state.signIn?.status !== "pending") auth("signin");
  });
  useEffect(() => {
    // Nothing is known yet: no sign-in starts, nothing completes.
    if (facts.provisional) return;
    if (step === "welcome" && !facts.signedIn)
      void startWebsiteSignIn(transport, automaticallySignIn).catch(() => {});
  }, [step, facts.provisional, facts.signedIn, transport]);
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
      {/* Outside the shell, which hosts the dialog everywhere else. */}
      <UpgradeDialogHost />
      <OnboardingStepPage
        step={step}
        facts={facts}
        transport={transport}
        navigate={navigateStep}
        signIn={auth}
        cancelSignIn={() => cancelSignIn(transport)}
        complete={(exit, options) => finish(exit, options?.tour === true)}
        createFirstBot={create}
        choose={choose}
        connect={connect}
      />
      {pairing && step === "connectors" && (
        <MessagingPlatformDialog
          key={pairing.platform}
          platform={pairing.platform}
          onClose={async () => {
            setPairing(null);
            const snapshot = await transport.client.messaging.snapshot({});
            const platform = pairing.platform;
            if (
              (platform === "whatsapp" ||
                platform === "telegram" ||
                platform === "discord") &&
              isMessagingPlatformConnected(snapshot, platform)
            )
              noteConnectedChatApp(platform);
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
    ownsBot: context.db.collections.bots.toArray.length > 0,
  };
};
/**
 * Warms a step's query without failing the load when it is cancelled. The
 * pending skeleton unmounts the outgoing step, whose observer may be the
 * query's last, and that cancels the fetch; the step's own query refetches.
 */
const warm = (load: Promise<unknown>) =>
  load.then(
    () => undefined,
    (error: unknown) => {
      if (!isCancelledError(error)) throw error;
    }
  );
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
    if (params.step === "connected")
      await context.transport.client.account.abacus(
        { refresh: true },
        { signal }
      );
    if (params.step === "models")
      await Promise.all([
        warm(
          context.queryClient.ensureQueryData(
            context.transport.orpc.settings.keys.listProviders.queryOptions({
              input: {},
            })
          )
        ),
        warm(
          context.queryClient.ensureQueryData(
            context.transport.orpc.models.list.queryOptions({ input: {} })
          )
        ),
      ]);
    // A network read: the step shows at once, its tiles waiting on it.
    if (params.step === "connectors")
      void warm(
        context.queryClient.ensureQueryData(
          context.transport.orpc.connectors.statuses.queryOptions({ input: {} })
        )
      ).catch(() => undefined);
    if (params.step === "first-bot")
      await context.db.collections.routines.preload();
    return { facts: await factsOf(context, signal) };
  },
  component: OnboardingRoute,
});
