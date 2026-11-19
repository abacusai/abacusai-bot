/**
 * `suggest_tasks`' buttons in a bot's chat: the tasks a reply ends with,
 * tapped instead of typed. A tap sends the button's own text as the user's
 * message (send-as-user.ts); a copy button puts its text on the clipboard for the
 * user to send from their phone. The buttons show once the reply is done
 * and only on the latest offer, until the user writes anything. A next step
 * under a result (contract next-step.ts) is the same card in any chat, with
 * a clock and a line on a routine's.
 */
import {
  isSuggestTasksTool,
  type SuggestedTask,
  suggestedTasks,
  suggestsNextStep,
} from "@abacus-ai/contract/bots/suggested-tasks";
import {
  deliverableOfferIgnored,
  EMPTY_DELIVERABLE_OFFER_CARD,
} from "@abacus-ai/contract/deliverable-offer";
import { funnelDetail } from "@abacus-ai/contract/funnel";
import { nextStepAllowed } from "@abacus-ai/contract/next-step";
import { parsePartialJSON, type UIMessage } from "@tanstack/ai-client";
import type { ToolProps } from "@tanstack/ai-react/ui";
import { ArrowRight, Check, Clock, Copy } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { useOptionalDb } from "#renderer/data/db";
import { turnsOf } from "#renderer/lib/bot-turns/turns";
import { cn } from "#renderer/lib/cn";
import { showError } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { hiddenUserMessage } from "#renderer/lib/user-message";

import { useHost, useThreadStore } from "../../store/selectors";
import { useChatView } from "../context";
import { retryOfferTarget } from "../retry-offer";
import { useSendAsUser } from "../send-as-user";
import { toolInput } from "./normalize";

/** Calls already counted as shown, so a re-render or a scroll back counts nothing. */
const shown = new Set<string>();

const COPIED_MS = 2000;

const offersTasks = (part: UIMessage["parts"][number]): boolean =>
  part.type === "tool-call" && isSuggestTasksTool(part.name);

/**
 * Whether the call in `messages` is still the one to answer: its reply is
 * there, no later call offers others, and the user has written nothing
 * since (the app's own notes do not count).
 */
const isLatestOffer = (
  messages: readonly UIMessage[],
  toolCallId: string
): boolean => {
  const index = messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.parts.some(
        (part) => part.type === "tool-call" && part.id === toolCallId
      )
  );
  if (index < 0) return false;
  const parts = messages[index]!.parts;
  const own = parts.findIndex(
    (part) => part.type === "tool-call" && part.id === toolCallId
  );
  return (
    !parts.slice(own + 1).some(offersTasks) &&
    messages
      .slice(index + 1)
      .every((message) =>
        message.role === "user"
          ? hiddenUserMessage(message)
          : message.role !== "assistant" || !message.parts.some(offersTasks)
      )
  );
};

export const SuggestedTasksCard = ({ part, result }: ToolProps<unknown>) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const db = useOptionalDb();
  const { session, composer } = useChatView();
  const sendAsUser = useSendAsUser();
  const messages = useHost(session, (state) => state.messages);
  const running = useThreadStore(session, (state) => state.runs.active != null);
  const [copied, setCopied] = useState<string | null>(null);
  // A tap answers the offer at once: a second tap must not send again.
  const [sent, setSent] = useState(false);
  const input = part.input == null ? null : toolInput(part, parsePartialJSON);
  const tasks = input == null ? [] : suggestedTasks(input);
  // A next step keeps its caps in prefs, as the deliverable offer does.
  const nextStep = suggestsNextStep(input);
  const card = db?.collections.prefs.get("app")?.dismissals.nextStepOffer;
  const turn = turnsOf(messages).length;
  const refused =
    result != null &&
    (result.state === "error" ||
      (result.state as string) === "output-error" ||
      result.error != null);
  const ready =
    tasks.length > 0 &&
    !sent &&
    !refused &&
    !running &&
    composer.readOnly == null &&
    isLatestOffer(messages, part.id) &&
    // The retry line wins a turn it has a reason for (complaint, repeat).
    (!nextStep || retryOfferTarget(messages) == null) &&
    (!nextStep ||
      card?.shownOffer === part.id ||
      nextStepAllowed(card, {
        id: part.id,
        threadId: session.threadId,
        turn,
      }));
  const template =
    composer.botId != null
      ? db?.collections.bots.get(composer.botId)?.templateId
      : null;
  const detail = funnelDetail(template ?? "custom");
  const offersRoutine = tasks.some((task) => task.routine);
  const reportShown = useEffectEvent(() => {
    // A relaunch redraws an offer already counted.
    if (nextStep && card?.shownOffer === part.id) return;
    if (nextStep) {
      const base = card ?? EMPTY_DELIVERABLE_OFFER_CARD;
      void db
        ?.updatePrefs({
          dismissals: {
            nextStepOffer: {
              ...base,
              misses:
                base.misses + (deliverableOfferIgnored(card, part.id) ? 1 : 0),
              shownOffer: part.id,
              shownThread: session.threadId,
              shownTurn: turn,
            },
          },
        })
        .catch(() => undefined);
    }
    void transport.client.system
      .funnelStep(
        nextStep
          ? {
              step: "next_step_shown",
              detail: offersRoutine ? "routine" : "work",
            }
          : { step: "task_suggestions_shown", detail }
      )
      .catch(() => undefined);
  });
  useEffect(() => {
    if (!ready || shown.has(part.id)) return;
    shown.add(part.id);
    reportShown();
  }, [ready, part.id]);
  useEffect(() => {
    if (copied == null) return;
    const timer = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!ready) return null;

  const tapped = (copy: boolean, routine = false) => {
    if (nextStep)
      void db
        ?.updatePrefs({
          dismissals: {
            nextStepOffer: {
              ...(card ?? EMPTY_DELIVERABLE_OFFER_CARD),
              answered: part.id,
              misses: 0,
            },
          },
        })
        .catch(() => undefined);
    void transport.client.system
      .funnelStep(
        nextStep
          ? { step: "next_step_tapped", detail: routine ? "routine" : "work" }
          : {
              step: "task_suggestion_tapped",
              detail: funnelDetail(`${copy ? "copy_" : ""}${detail}`),
            }
      )
      .catch(() => undefined);
  };
  const send = (text: string, routine: boolean) =>
    sendAsUser(text, {
      accepted: () => {
        setSent(true);
        tapped(false, routine);
      },
      failed: () => setSent(false),
    });
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => {
        tapped(true);
        setCopied(text);
      },
      () => showError(t("chat.suggestedTasks.copyFailed"))
    );

  return (
    <SuggestedTaskList
      tasks={tasks}
      nextStep={nextStep}
      copied={copied}
      onTap={(task) =>
        task.copy ? copy(task.text) : send(task.text, task.routine)
      }
    />
  );
};

/**
 * The tasks as one card: a label, then a row per task with its icon, the
 * text and an arrow. The first row's tile is filled, as the likeliest answer.
 */
const SuggestedTaskList = ({
  tasks,
  nextStep,
  copied,
  onTap,
}: {
  tasks: readonly SuggestedTask[];
  nextStep: boolean;
  copied: string | null;
  onTap(task: SuggestedTask): void;
}) => {
  const { t } = useTranslation();
  const label = t(
    nextStep ? "chat.suggestedTasks.next" : "chat.suggestedTasks.pickOne"
  );
  return (
    <div
      data-slot="suggested-tasks"
      role="group"
      aria-label={label}
      className="bg-card my-2 flex w-full max-w-[520px] flex-col overflow-hidden rounded-xl border"
    >
      <p className="text-muted-foreground px-3.5 pt-2.5 pb-1.5 text-xs font-medium">
        {label}
      </p>
      <div className="divide-border divide-y border-t">
        {tasks.map((task, index) => {
          const Icon = task.copy
            ? copied === task.text
              ? Check
              : Copy
            : task.routine
              ? Clock
              : ArrowRight;
          const line = task.copy
            ? copied === task.text
              ? t("chat.suggestedTasks.copied")
              : null
            : task.routine
              ? t("chat.suggestedTasks.routineLine")
              : null;
          return (
            <button
              key={task.text}
              type="button"
              data-task={task.copy ? "copy" : task.routine ? "routine" : "send"}
              className="group/task hover:bg-muted focus-visible:ring-ring/50 flex w-full items-center gap-3 px-3.5 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset"
              {...(task.copy
                ? {
                    "aria-label": t("chat.suggestedTasks.copy", {
                      text: task.text,
                    }),
                  }
                : {})}
              onClick={() => onTap(task)}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-lg",
                  index === 0
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-foreground border"
                )}
              >
                <Icon className="size-4" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium [overflow-wrap:anywhere]">
                  {task.text}
                </span>
                {line != null && (
                  <span className="text-muted-foreground text-xs">{line}</span>
                )}
              </span>
              <ArrowRight
                aria-hidden
                className="text-muted-foreground group-hover/task:text-foreground size-4 shrink-0 transition-colors"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
};
