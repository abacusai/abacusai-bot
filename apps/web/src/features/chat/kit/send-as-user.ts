/**
 * A button that speaks for the user: its text goes out as their message,
 * through the routing the composer submits with (sent, or queued behind a
 * run). A refusal or a failure is toasted and handed back to the caller.
 */
import { useTranslation } from "react-i18next";

import { showError } from "#renderer/lib/toast";

import { routeSubmit } from "../runtime/send";
import {
  questionPending,
  useBusy,
  useHost,
  useThreadStore,
} from "../store/selectors";
import { useChatView } from "./context";

export interface SendAsUserHandlers {
  /** The message was admitted or queued. */
  accepted(): void;
  /** It never went after all. */
  failed(): void;
}

export const useSendAsUser = () => {
  const { t } = useTranslation();
  const { session, runtime, threadId, composer } = useChatView();
  const hydrated = useHost(session, (state) => state.ready);
  const busy = useBusy(session, composer.turnBusy === true);
  const question = useThreadStore(session, questionPending);
  return (text: string, handlers: SendAsUserHandlers): void => {
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
      handlers.accepted();
      void runtime.queue.enqueue(threadId, route.text).catch(() => {
        handlers.failed();
        showError(t("chat.composer.queueFailed"));
      });
      return;
    }
    if (route.kind !== "send") return;
    handlers.accepted();
    void session
      .submit(route.text, route.forwardedProps)
      .then((admission) => {
        if (admission.kind !== "rejected") return;
        handlers.failed();
        showError(t("chat.composer.rejected"));
      })
      .catch(() => {
        handlers.failed();
        showError(t("chat.composer.notReady"));
      });
  };
};
