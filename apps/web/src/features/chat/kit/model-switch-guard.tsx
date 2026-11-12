/**
 * Every way a chat that already has messages changes its model goes through
 * here: the composer's picker, a card's "Continue on" button, and the resume
 * after an upgrade. A model reads none of another model's prompt cache, so
 * the switch sends the whole chat to the new model again, uncached, on every
 * call that follows. On a long chat one message can then cost a large part of
 * a month's credits. So before the switch the user sees what it costs and
 * chooses: a new chat on that model that starts from a summary of this one
 * (same folder and files), the switch here anyway, or neither.
 *
 * A switch to a model that costs nothing (the free pool, another
 * provider's free model) is never asked, however long the chat is. A custom or local endpoint is asked
 * too: it bills its owner, not Abacus credits, so its warning says what the
 * switch costs without naming credits. A bot's chat has no new chat to offer
 * (the bot keeps one thread): it gets the warning with the switch and Cancel.
 */
import type { RunOutcomeRecord } from "@abacus-ai/contract/contract/ai-thread";
import {
  type AbacusBotModel,
  OPENLLM_ID,
  resolveConfiguredModel,
} from "@abacus-ai/contract/models";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Spinner } from "#renderer/components/spinner";
import { lastUserText } from "#renderer/lib/upgrade-dialog";
import { useAppContext } from "#renderer/lib/use-app-context";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#renderer/ui/alert-dialog";
import { Button } from "#renderer/ui/button";

import type { ThreadSession } from "../runtime/session";
import type { ComposerConfig } from "./context";

/** What the user chose: the switch here, a new chat, or neither. */
export type ModelSwitchChoice = "here" | "new-chat" | "cancelled";

/**
 * A model that costs nothing to run: the free pool, or another provider's
 * free model. An Abacus model always spends credits, even one a free plan's
 * catalog lists as "free" (that plan's whole catalog reads so, and a catalog
 * read before an upgrade still does after it).
 */
export const billsNothing = (
  model: Pick<AbacusBotModel, "id" | "tier" | "provider">
) =>
  model.id === OPENLLM_ID ||
  (model.tier === "free" && model.provider !== "abacus");

/**
 * Whether switching a chat from `current` to `target` must be asked first:
 * the chat has messages, the model changes, and the new one bills. An
 * unknown target (the catalog not read yet) is asked: the dialog is the safe
 * side of not knowing.
 */
export const switchNeedsAsking = ({
  hasMessages,
  current,
  target,
}: {
  hasMessages: boolean;
  current: string | null;
  target: { id: string; row: AbacusBotModel | null };
}): boolean =>
  hasMessages &&
  target.id !== current &&
  !(target.row != null && billsNothing(target.row));

/** How long the chat was at its last run that reported it. */
export const chatContextTokens = (
  outcomes: readonly RunOutcomeRecord[]
): number | undefined =>
  outcomes.findLast((outcome) => outcome.contextTokens != null)?.contextTokens;

interface Asking {
  model: string;
  label: string;
  /** Billed in Abacus credits (unknown counts as yes): the warning names them. */
  credits: boolean;
  tokens: number | undefined;
  /** The new chat sends this at once: the message the switch was for. */
  prompt: string | undefined;
  resolve(choice: ModelSwitchChoice): void;
}

export const useModelSwitchGuard = (
  composer: ComposerConfig,
  session: ThreadSession
): { composer: ComposerConfig; dialog: ReactNode } => {
  const { t, i18n } = useTranslation();
  const { transport } = useAppContext();
  const enabled = composer.model != null && composer.readOnly == null;
  const { data: catalog } = useQuery({
    ...transport.orpc.models.list.queryOptions({ input: {} }),
    enabled,
    staleTime: 60_000,
  });
  const { data: settings } = useQuery({
    ...transport.orpc.settings.get.queryOptions({ input: {} }),
    enabled,
    staleTime: 60_000,
  });
  const [asking, setAsking] = useState<Asking | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [failed, setFailed] = useState(false);

  const resolveModel = (id: string | null) => {
    const resolved =
      catalog != null
        ? resolveConfiguredModel({
            requested: id,
            defaultModel: settings?.defaultModel,
            catalog,
          })
        : id;
    return {
      id: resolved ?? id ?? "",
      row: catalog?.find((model) => model.id === resolved) ?? null,
    };
  };

  /** Asks when the switch needs it; answers "here" when it does not. */
  const ask = (
    id: string | null,
    { prompt }: { prompt?: boolean } = {}
  ): Promise<ModelSwitchChoice> => {
    const host = session.hostStore.state;
    const target = resolveModel(id);
    const binding = composer.model;
    const current = resolveModel(binding?.value ?? null).id;
    if (
      !switchNeedsAsking({
        hasMessages: host.messages.length > 0,
        current: binding?.resolved ?? current,
        target,
      })
    )
      return Promise.resolve("here");
    return new Promise((resolve) => {
      setFailed(false);
      setAsking({
        model: target.id,
        label: target.row?.label ?? target.id,
        credits: target.row == null || target.row.provider === "abacus",
        tokens: chatContextTokens(host.store.state.runs.outcomes),
        prompt: prompt === true ? lastUserText(host.messages) : undefined,
        resolve,
      });
    });
  };

  const close = (choice: ModelSwitchChoice) => {
    asking?.resolve(choice);
    setAsking(null);
    setPreparing(false);
    setFailed(false);
  };

  const newChat = composer.onContinueInNewChat;
  const continueThere = async () => {
    if (asking == null || newChat == null) return;
    setPreparing(true);
    setFailed(false);
    try {
      await newChat(asking.model, asking.prompt);
    } catch {
      // Nothing opened: the dialog stays for another try.
      setPreparing(false);
      setFailed(true);
      return;
    }
    close("new-chat");
  };

  const binding = composer.model;
  const guarded: ComposerConfig = {
    ...composer,
    ...(binding != null
      ? {
          model: {
            ...binding,
            onChange: (id) =>
              void ask(id).then((choice) => {
                if (choice === "here") binding.onChange(id);
              }),
          },
        }
      : {}),
    ...(composer.onSwitchThisChat != null
      ? {
          onSwitchThisChat: async (model) => {
            const choice = await ask(model, { prompt: true });
            if (choice !== "here") return choice;
            return composer.onSwitchThisChat!(model);
          },
        }
      : {}),
    ...(composer.onResumeOnModel != null
      ? {
          onResumeOnModel: async (model) => {
            const choice = await ask(model, { prompt: true });
            if (choice !== "here") return choice;
            return composer.onResumeOnModel!(model);
          },
        }
      : {}),
  };

  const tokens =
    asking?.tokens != null
      ? new Intl.NumberFormat(i18n.language, {
          notation: "compact",
          maximumFractionDigits: 0,
        }).format(asking.tokens)
      : null;

  const dialog = (
    <AlertDialog
      open={asking != null}
      onOpenChange={(open) => {
        if (!open && !preparing) close("cancelled");
      }}
    >
      <AlertDialogContent
        className="data-[size=default]:max-w-md data-[size=default]:sm:max-w-lg"
        data-slot="model-switch-dialog"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {newChat != null
              ? t("chat.modelSwitch.title", { model: asking?.label ?? "" })
              : t("chat.modelSwitch.titleHere", {
                  model: asking?.label ?? "",
                })}
          </AlertDialogTitle>
          <AlertDialogDescription className="flex flex-col gap-2 text-left">
            <span>
              {tokens != null
                ? t("chat.modelSwitch.costSized", {
                    model: asking?.label ?? "",
                    tokens,
                  })
                : t("chat.modelSwitch.cost", { model: asking?.label ?? "" })}
            </span>
            <span>
              {asking?.credits === false
                ? t("chat.modelSwitch.costly")
                : t("chat.modelSwitch.credits")}
            </span>
            {newChat != null && (
              <span className="text-foreground">
                {t("chat.modelSwitch.newChatWhy")}
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {failed && (
          <p role="alert" className="text-destructive text-xs">
            {t("chat.continuation.failed")}
          </p>
        )}
        <AlertDialogFooter className="flex-col gap-2 sm:flex-col">
          {newChat != null && (
            <Button
              autoFocus
              disabled={preparing}
              data-action="model-switch-new-chat"
              onClick={() => void continueThere()}
            >
              {preparing && <Spinner data-icon="inline-start" />}
              {preparing
                ? t("chat.continuation.preparing", {
                    model: asking?.label ?? "",
                  })
                : t("chat.modelSwitch.newChat", {
                    model: asking?.label ?? "",
                  })}
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={preparing}
            data-action="model-switch-here"
            {...(newChat == null && { autoFocus: true })}
            onClick={() => close("here")}
          >
            {t("chat.modelSwitch.here", { model: asking?.label ?? "" })}
          </Button>
          <Button
            variant="ghost"
            disabled={preparing}
            data-action="model-switch-cancel"
            onClick={() => close("cancelled")}
          >
            {t("chat.modelSwitch.cancel")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return { composer: guarded, dialog };
};
