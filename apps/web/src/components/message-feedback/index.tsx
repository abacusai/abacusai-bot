import type { TurnFeedbackOutcome } from "@abacus-ai/contract/contracts";
/**
 * Two feedback buttons in the action bar, with an optional comment.
 * A second click on the chosen rating sends `clear`,
 * sent as `agent.feedback`. Offered only with an Abacus account (the route
 * decides) and never on the live run (the decorations decide).
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
  rating: Rating | null;
  comment: string;
  status: Status;
}

const IDLE: FeedbackState = { rating: null, comment: "", status: "idle" };
const states = new Map<string, FeedbackState>();
const listeners = new Map<string, Set<() => void>>();

const readState = (id: string): FeedbackState => states.get(id) ?? IDLE;
const writeState = (id: string, patch: Partial<FeedbackState>): void => {
  states.set(id, { ...readState(id), ...patch });
  for (const listener of listeners.get(id) ?? []) listener();
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

/** Tests: forget every reply's feedback state. */
export const clearFeedbackStates = (): void => {
  states.clear();
};

export const MessageFeedback = ({ id, send }: MessageFeedbackProps) => {
  const { t } = useTranslation();
  const own = useId();
  const key = id ?? own;
  const { rating, comment, status } = useSyncExternalStore(
    (listener) => subscribeState(key, listener),
    () => readState(key),
    () => readState(key)
  );

  const submit = (next: Rating | "clear", text?: string): void => {
    writeState(key, { status: "sending" });
    send(next, text)
      .then((outcome) =>
        writeState(key, {
          status: outcome.ok
            ? "sent"
            : outcome.reason === "not-synced"
              ? "not-synced"
              : "failed",
        })
      )
      .catch(() => writeState(key, { status: "failed" }));
  };

  const rate = (next: Rating): void => {
    if (rating === next) {
      writeState(key, { rating: null });
      submit("clear");
      return;
    }
    writeState(key, { rating: next });
    submit(next);
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
                      className="aria-pressed:bg-foreground/10 rounded-full"
                      aria-label={t(label)}
                      aria-pressed={rating === value}
                      data-status={status}
                      onClick={() => rate(value)}
                    />
                  }
                />
              }
            >
              <Icon aria-hidden className="size-4" />
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
                submit(rating, comment.trim() || undefined);
              }}
            >
              <Textarea
                aria-label={t("bots.chat.feedback.tellUsMore")}
                placeholder={t("bots.chat.feedback.placeholder")}
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
                disabled={status === "sending" || comment.trim() === ""}
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
