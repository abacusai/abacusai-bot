/**
 * `suggest_tasks`' buttons in a bot's chat: the tasks a reply ends with,
 * tapped instead of typed. A tap sends the button's own text as the user's
 * message, through the same routing the composer submits with (sent, or
 * queued behind a run); a copy button puts its text on the clipboard for the
 * user to send from their phone. The buttons show once the reply is done
 * and only on the latest offer, until the user writes anything.
 */
import { suggestedTasks } from "@abacus-ai/contract/bots/suggested-tasks";
import { funnelDetail } from "@abacus-ai/contract/funnel";
import { parsePartialJSON, type UIMessage } from "@tanstack/ai-client";
import type { ToolProps } from "@tanstack/ai-react/ui";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useOptionalDb } from "#renderer/data/db";
import { isSuggestTasksTool } from "#renderer/lib/bot-turns/turns";
import { showError } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { hiddenUserMessage } from "#renderer/lib/user-message";
import { Button } from "#renderer/ui/button";

import { routeSubmit } from "../../runtime/send";
import {
  questionPending,
  useBusy,
  useHost,
  useThreadStore,
} from "../../store/selectors";
import { useChatView } from "../context";
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
  const { session, runtime, threadId, composer } = useChatView();
  const messages = useHost(session, (state) => state.messages);
  const hydrated = useHost(session, (state) => state.ready);
  const busy = useBusy(session, composer.turnBusy === true);
  const running = useThreadStore(session, (state) => state.runs.active != null);
  const question = useThreadStore(session, questionPending);
  const [copied, setCopied] = useState<string | null>(null);
  // A tap answers the offer at once: a second tap must not send again.
  const [sent, setSent] = useState(false);
  const tasks =
    part.input == null ? [] : suggestedTasks(toolInput(part, parsePartialJSON));
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
    isLatestOffer(messages, part.id);
  const template =
    composer.botId != null
      ? db?.collections.bots.get(composer.botId)?.templateId
      : null;
  const detail = funnelDetail(template ?? "custom");
  useEffect(() => {
    if (!ready || shown.has(part.id)) return;
    shown.add(part.id);
    void transport.client.system
      .funnelStep({ step: "task_suggestions_shown", detail })
      .catch(() => undefined);
  }, [ready, part.id, transport, detail]);
  useEffect(() => {
    if (copied == null) return;
    const timer = setTimeout(() => setCopied(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!ready) return null;

  const tapped = (copy: boolean) =>
    void transport.client.system
      .funnelStep({
        step: "task_suggestion_tapped",
        detail: funnelDetail(`${copy ? "copy_" : ""}${detail}`),
      })
      .catch(() => undefined);
  const send = (text: string) => {
    const route = routeSubmit({
      text,
      attachments: [],
      busy,
      readOnly: false,
      questionPending: question,
      preStart: composer.preStart === true,
      hydrated,
      ...(composer.fixedMode != null ? { fixedMode: composer.fixedMode } : {}),
    });
    if (route.kind === "enqueue") {
      setSent(true);
      tapped(false);
      void runtime.queue.enqueue(threadId, route.text).catch(() => {
        setSent(false);
        showError(t("chat.composer.queueFailed"));
      });
      return;
    }
    if (route.kind !== "send") return;
    setSent(true);
    tapped(false);
    void session
      .submit(route.text, route.forwardedProps)
      .then((admission) => {
        if (admission.kind !== "rejected") return;
        setSent(false);
        showError(t("chat.composer.rejected"));
      })
      .catch(() => {
        setSent(false);
        showError(t("chat.composer.notReady"));
      });
  };
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => {
        tapped(true);
        setCopied(text);
      },
      () => showError(t("chat.suggestedTasks.copyFailed"))
    );

  return (
    <div
      data-slot="suggested-tasks"
      role="group"
      aria-label={t("chat.suggestedTasks.label")}
      className="my-2 flex w-full max-w-[520px] flex-wrap gap-2"
    >
      {tasks.map((task) => (
        <Button
          key={task.text}
          size="sm"
          variant="outline"
          className="h-auto max-w-full rounded-full py-1.5 text-left whitespace-normal"
          {...(task.copy
            ? {
                "aria-label": t("chat.suggestedTasks.copy", {
                  text: task.text,
                }),
              }
            : {})}
          onClick={() => (task.copy ? copy(task.text) : send(task.text))}
        >
          {task.copy &&
            (copied === task.text ? (
              <Check aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <Copy aria-hidden className="size-3.5 shrink-0" />
            ))}
          <span className="min-w-0">{task.text}</span>
        </Button>
      ))}
    </div>
  );
};
