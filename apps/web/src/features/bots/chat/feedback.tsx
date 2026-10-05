import type { TurnFeedbackOutcome } from "@abacus-ai/contract/contracts";
/**
 * Per-message feedback on a bot's reply (spec 03 §11.3, parity P59): a "…"
 * shown on hover or focus of a completed assistant message opens 👍 / 👎
 * (a second click on the chosen one sends `clear`) and an optional comment,
 * sent as `agent.feedback`. Offered only with an Abacus account (the route
 * decides) and never on the live run (the decorations decide).
 */
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";
import { Button } from "#renderer/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "#renderer/ui/popover";
import { Textarea } from "#renderer/ui/textarea";

type Rating = "up" | "down";

export interface MessageFeedbackProps {
  send(
    rating: Rating | "clear",
    comment?: string
  ): Promise<TurnFeedbackOutcome>;
}

type Status = "idle" | "sending" | "sent" | "not-synced" | "failed";

export const MessageFeedback = ({ send }: MessageFeedbackProps) => {
  const { t } = useTranslation();
  const [rating, setRating] = useState<Rating | null>(null);
  const [comment, setComment] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  const submit = (next: Rating | "clear", text?: string): void => {
    setStatus("sending");
    send(next, text)
      .then((outcome) =>
        setStatus(
          outcome.ok
            ? "sent"
            : outcome.reason === "not-synced"
              ? "not-synced"
              : "failed"
        )
      )
      .catch(() => setStatus("failed"));
  };

  const rate = (next: Rating): void => {
    if (rating === next) {
      setRating(null);
      submit("clear");
      return;
    }
    setRating(next);
    submit(next);
  };

  return (
    <div
      data-slot="message-feedback"
      className="opacity-0 transition-opacity focus-within:opacity-100 hover:opacity-100 has-[[aria-expanded=true]]:opacity-100 [[data-role=assistant]:hover_&]:opacity-100"
    >
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("bots.chat.feedback.rate")}
              className="text-muted-foreground"
            />
          }
        >
          <MoreHorizontal />
        </PopoverTrigger>
        <PopoverContent align="start" className="flex w-64 flex-col gap-2">
          <div className="flex gap-1">
            {(
              [
                ["up", "👍", "bots.chat.feedback.helpful"],
                ["down", "👎", "bots.chat.feedback.notHelpful"],
              ] as const
            ).map(([value, emoji, label]) => (
              <Button
                key={value}
                variant={rating === value ? "secondary" : "ghost"}
                size="icon"
                aria-label={t(label)}
                aria-pressed={rating === value}
                onClick={() => rate(value)}
              >
                <span aria-hidden>{emoji}</span>
              </Button>
            ))}
          </div>
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
                onChange={(event) => setComment(event.target.value)}
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
