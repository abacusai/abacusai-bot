import type { TurnFeedbackOutcome } from "@abacus-ai/contract/contracts";
/**
 * Two feedback buttons in the action bar, with an optional comment, sent as
 * `agent.feedback`. A second click on a rating the server holds sends
 * `clear`; on one that failed to send, it sends it again. A failed `clear`
 * puts the held rating back, so the pressed thumb, the open form and the
 * status line always describe the same rating. Offered only with an Abacus
 * account (the route decides) and never on the live run (the decorations
 * decide).
 *
 * The same controls appear in a reply's hover menu and in its right-click
 * menu, so the rating, the comment and the send status live in a small
 * store keyed by `id` (the reply's feedback segment): whichever menu rated
 * the reply, the other shows it pressed and its outcome.
 */
import { ThumbsUp, ThumbsDown } from "lucide-react";
import { useId, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";
import { Button } from "#renderer/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "#renderer/ui/popover";
import { Textarea } from "#renderer/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "#renderer/ui/tooltip";

type Rating = "up" | "down";

/** Shared look of the turn/message action buttons (Copy, thumbs): 28px, muted. */
export const ACTION_BUTTON_CLASS =
  "text-muted-foreground hover:text-foreground hover:bg-muted aria-pressed:bg-primary/10 aria-pressed:text-primary aria-pressed:hover:bg-primary/15 aria-pressed:[&_svg]:fill-current";
export const ACTION_ICON_CLASS = "size-4";
export const ACTION_ICON_STROKE = 1.75;

export interface MessageFeedbackProps {
  /** The reply's feedback segment; absent, the controls keep their own state. */
  id?: string;
  send(
    rating: Rating | "clear",
    comment?: string
  ): Promise<TurnFeedbackOutcome>;
}

type Status = "idle" | "sending" | "sent" | "not-synced" | "failed";

interface FeedbackState {
  /** The rating shown pressed: the one sent, being sent or failed to send. */
  rating: Rating | null;
  /** The rating the server holds, after the last send that landed. */
  held: Rating | null;
  comment: string;
  status: Status;
}

const IDLE: FeedbackState = {
  rating: null,
  held: null,
  comment: "",
  status: "idle",
};
const states = new Map<string, FeedbackState>();
const listeners = new Map<string, Set<() => void>>();
/** Told of every reply's change, for whole-thread questions. */
const anyListeners = new Set<() => void>();

const readState = (id: string): FeedbackState => states.get(id) ?? IDLE;
const writeState = (id: string, patch: Partial<FeedbackState>): void => {
  states.set(id, { ...readState(id), ...patch });
  for (const listener of listeners.get(id) ?? []) listener();
  for (const listener of anyListeners) listener();
};
const subscribeState = (id: string, listener: () => void): (() => void) => {
  const set = listeners.get(id) ?? new Set();
  set.add(listener);
  listeners.set(id, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(id);
  };
};

/** A reply of `threadId` holds a thumb (keys are `<thread>:<segment>`). */
const threadHasThumb = (threadId: string): boolean => {
  for (const [key, state] of states)
    if (state.rating != null && key.startsWith(`${threadId}:`)) return true;
  return false;
};

const subscribeAny = (listener: () => void): (() => void) => {
  anyListeners.add(listener);
  return () => anyListeners.delete(listener);
};

/** Whether the user thumbed any reply of `threadId`, kept current. */
export const useThreadHasThumb = (threadId: string): boolean => {
  const read = (): boolean => threadHasThumb(threadId);
  return useSyncExternalStore(subscribeAny, read, read);
};

/** Tests: forget every reply's feedback state. */
export const clearFeedbackStates = (): void => {
  states.clear();
};

export const MessageFeedback = ({ id, send }: MessageFeedbackProps) => {
  const { t } = useTranslation();
  const own = useId();
  const key = id ?? own;
  const { rating, held, comment, status } = useSyncExternalStore(
    (listener) => subscribeState(key, listener),
    () => readState(key),
    () => readState(key)
  );

  const submit = (next: Rating | "clear", text?: string): void => {
    writeState(key, {
      rating: next === "clear" ? null : next,
      status: "sending",
    });
    const fail = (failure: "not-synced" | "failed"): void =>
      writeState(key, {
        status: failure,
        // The server still holds what a failed clear meant to withdraw.
        ...(next === "clear" && { rating: readState(key).held }),
      });
    send(next, text)
      .then((outcome) => {
        if (outcome.ok)
          writeState(key, {
            status: "sent",
            held: next === "clear" ? null : next,
          });
        else fail(outcome.reason === "not-synced" ? "not-synced" : "failed");
      })
      .catch(() => fail("failed"));
  };

  const unsent = status === "failed" || status === "not-synced";
  const typed = comment.trim() || undefined;

  const rate = (next: Rating): void => {
    if (status === "sending") return;
    if (rating === next && held === next) submit("clear");
    else if (rating === next)
      submit(next, typed); // retry the failed send
    else submit(next);
  };

  return (
    <div data-slot="message-feedback" className="flex items-center gap-0.5">
      <Popover>
        {(
          [
            ["up", ThumbsUp, "bots.chat.feedback.helpful"],
            ["down", ThumbsDown, "bots.chat.feedback.notHelpful"],
          ] as const
        ).map(([value, Icon, label]) => (
          <Tooltip key={value}>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className={ACTION_BUTTON_CLASS}
                      aria-label={t(label)}
                      aria-pressed={rating === value}
                      data-status={status}
                      onClick={() => rate(value)}
                    />
                  }
                />
              }
            >
              <Icon
                aria-hidden
                className={ACTION_ICON_CLASS}
                strokeWidth={ACTION_ICON_STROKE}
              />
            </TooltipTrigger>
            <TooltipContent>{t(label)}</TooltipContent>
          </Tooltip>
        ))}
        <PopoverContent align="start" className="flex w-64 flex-col gap-2">
          {rating != null && (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                submit(rating, typed);
              }}
            >
              <Textarea
                aria-label={t("bots.chat.feedback.tellUsMore")}
                placeholder={t(
                  rating === "up"
                    ? "bots.chat.feedback.placeholderUp"
                    : "bots.chat.feedback.placeholderDown"
                )}
                value={comment}
                onChange={(event) =>
                  writeState(key, { comment: event.target.value })
                }
                className="min-h-16 text-xs"
              />
              <Button
                type="submit"
                size="sm"
                className="self-end"
                // After a failed send, an empty comment still retries the rating.
                disabled={status === "sending" || (typed == null && !unsent)}
              >
                {t("bots.chat.feedback.send")}
              </Button>
            </form>
          )}
          <p
            role="status"
            className={cn(
              "text-xs",
              status === "failed" || status === "not-synced"
                ? "text-destructive"
                : "text-muted-foreground",
              (status === "idle" || status === "sending") && "sr-only"
            )}
          >
            {status === "sent"
              ? t("bots.chat.feedback.sent")
              : status === "not-synced"
                ? t("bots.chat.feedback.notSynced")
                : status === "failed"
                  ? t("bots.chat.feedback.failed")
                  : ""}
          </p>
        </PopoverContent>
      </Popover>
    </div>
  );
};
