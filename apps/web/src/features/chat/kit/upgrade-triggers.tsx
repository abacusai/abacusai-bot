import type { UIMessage } from "@tanstack/ai-client";
import { useStore } from "@tanstack/react-store";
import { useEffect, useEffectEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  ownKeyFailure,
  type OwnKeyFailure,
} from "#renderer/lib/own-key-unavailable";
import {
  connectorCreditRefusals,
  lastUserText,
  requestUpgradeDialog,
  resumeHandoffStore,
  takeResumeHandoff,
  taskText,
  type UpgradeDialogKind,
  type UpgradeDialogRequest,
} from "#renderer/lib/upgrade-dialog";

import { useHost, useThreadStore } from "../store/selectors";
import type { RunOutcomeRecord } from "../store/thread-store";
import { useChatView } from "./context";
import { noteTopModelResume } from "./router-after-upgrade";

/** Recorded by the live post-hook, not merged from a hydrate or a page. */
export const isLive = (outcome: RunOutcomeRecord): boolean =>
  (outcome as RunOutcomeRecord & { live?: boolean }).live === true;

const errorActions = (outcome: RunOutcomeRecord) =>
  (
    outcome.error as
      | {
          actions?: Array<{ type?: string; provider?: string; cause?: string }>;
        }
      | undefined
  )?.actions ?? [];

export const outOfAbacusCredits = (outcome: RunOutcomeRecord): boolean =>
  errorActions(outcome).some((action) => action.type === "upgrade-abacus");

/** The Abacus wall is a free tier that ended, rather than its credits running out. */
export const creditsExpired = (
  actions: ReadonlyArray<{ type?: string; cause?: string }> | undefined
): boolean =>
  actions?.some(
    (action) => action.type === "upgrade-abacus" && action.cause === "expired"
  ) === true;

/**
 * Sends the waiting message again once the plan is active. With a model the
 * chat moves onto it first, since the key that failed stays dry; the retry
 * carries the model too, so a refused move still sends. `thisChatOnly` moves
 * the chat alone and leaves the app's default model as it is.
 */
export const useUpgradeResume = ({ thisChatOnly = false } = {}) => {
  const { t } = useTranslation();
  const { session, composer, skin } = useChatView();
  const fixedMode = composer.fixedMode;
  return async (model?: string) => {
    if (model != null) {
      const moved = await (
        thisChatOnly
          ? composer.onSwitchThisChat?.(model)
          : composer.onResumeOnModel?.(model)
      )?.catch(() => undefined);
      // A new chat took the waiting message, or the user kept this chat as it is.
      if (moved === "new-chat" || moved === "cancelled") return;
    }
    return session.retry(
      model != null || fixedMode
        ? {
            ...(model != null ? { model } : {}),
            ...(fixedMode ? { mode: fixedMode } : {}),
          }
        : undefined,
      skin === "bot" ? t("workspace.retryMessage") : undefined
    );
  };
};

/**
 * What a free credit wall's ask carries in a listed chat: the task the
 * dialog's title names, and a resume that runs the waiting message on the top
 * model the dialog picks, in this chat alone. Once that turn ends clean the
 * chat is offered its plan's router in a new chat (router-after-upgrade.tsx).
 * A bot's chat or a routine's keeps its model, so it gets neither.
 */
export const useCreditWallTask = () => {
  const { session, composer } = useChatView();
  const resume = useUpgradeResume({ thisChatOnly: true });
  return (
    messages: readonly UIMessage[]
  ): Pick<UpgradeDialogRequest, "task" | "resume"> => {
    const task =
      composer.onContinueInNewChat != null ? taskText(messages) : undefined;
    if (task == null) return {};
    return {
      task,
      resume: (model?: string) => {
        if (model != null) noteTopModelResume(session.threadId);
        return resume(model);
      },
    };
  };
};

/**
 * Asks for the upgrade dialog from the chat on screen, for what happens in it
 * now: a turn that stopped because the Abacus credits ran out or the person's
 * own provider key did, or a connector call refused for Abacus credits.
 * Read-only views (routine runs, channel chats) never ask; the person is not
 * there to answer.
 */
export const UpgradeTriggers = ({
  messages,
  outcome,
}: {
  messages: readonly UIMessage[];
  /** The latest run's outcome while the thread is idle. */
  outcome: RunOutcomeRecord | undefined;
}) => {
  const { session, composer } = useChatView();
  const fresh = useThreadStore(session, (state) => state.fresh);
  const canReply = composer.readOnly == null;
  const resume = useUpgradeResume();
  const wallTask = useCreditWallTask();

  // The wall asked again on return, and the plan landed with this chat off
  // screen: the waiting message goes now, as the live wall's would.
  const handoff = useStore(resumeHandoffStore, (state) =>
    state?.threadId === session.threadId ? state : null
  );
  const loaded = messages.length > 0;
  const runHandoff = useEffectEvent(() => {
    const taken = takeResumeHandoff(session.threadId);
    if (taken == null) return;
    void (wallTask(messages).resume ?? resume)(taken.model).catch(() => {});
  });
  useEffect(() => {
    if (handoff != null && canReply && loaded) runHandoff();
  }, [handoff, canReply, loaded]);

  // This run's end, live or brought in by a snapshot when it ended before the
  // view caught up: a fast failure is the person's moment as much as a slow one.
  // Read off the host store: a new chat's first message is handed to the
  // thread after its view loads, so the run can end before it is known here.
  const sentHere = useHost(
    session,
    () => outcome != null && session.sentHere(outcome.runId)
  );
  const ended = outcome != null && (isLive(outcome) || sentHere);
  const creditsKey =
    canReply && outcome != null && ended && outOfAbacusCredits(outcome)
      ? `credits:${outcome.runId}`
      : null;
  // One ask per key; the messages and resume are read at that moment.
  const ask = useEffectEvent(
    (kind: UpgradeDialogKind, key: string, ownKey?: OwnKeyFailure) =>
      requestUpgradeDialog({
        kind,
        key,
        threadId: session.threadId,
        pendingText: lastUserText(messages),
        ...(ownKey != null ? { ownKey } : {}),
        ...(kind === "credits" &&
        outcome != null &&
        creditsExpired(errorActions(outcome))
          ? { expired: true }
          : {}),
        resume,
        ...(kind === "credits" ? wallTask(messages) : {}),
      })
  );
  useEffect(() => {
    if (creditsKey != null) ask("credits", creditsKey);
  }, [creditsKey]);

  // The host opens it only for a free account; a paid one gets the card.
  // With Abacus credits left the card offers RouteLLM - Open instead.
  const ownKey =
    canReply &&
    outcome != null &&
    ended &&
    !errorActions(outcome).some((action) => action.type === "switch-to-abacus")
      ? ownKeyFailure(errorActions(outcome))
      : null;
  // The dialog names the failure as the card does: the model by its label.
  const ownKeyKey = ownKey != null ? `own-key:${outcome?.runId ?? ""}` : null;
  // Read at that moment, as the messages and resume are.
  const askOwnKey = useEffectEvent((key: string) => {
    if (ownKey != null) ask("own-key", key, ownKey);
  });
  useEffect(() => {
    if (ownKeyKey != null) askOwnKey(ownKeyKey);
  }, [ownKeyKey]);

  const refused = canReply ? connectorCreditRefusals(messages, fresh) : [];
  const connectorKey =
    refused.length > 0 ? `connectors:${refused.at(-1)}` : null;
  useEffect(() => {
    if (connectorKey != null) ask("connectors", connectorKey);
  }, [connectorKey]);

  return null;
};
