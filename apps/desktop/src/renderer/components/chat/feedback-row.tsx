import { Check, Copy, ThumbsDown, ThumbsUp } from "lucide-react";
/**
 * Per-turn feedback row: thumbs, copy, and the compute-points chip, rendered
 * under the LAST bot text segment of a settled turn so a turn gets one row.
 */
import { useCallback, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { Segment } from "../../conversation";
import { Button } from "../ui";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

/** Matches the platform's cap; longer text is cut there anyway. */
export const MAX_FEEDBACK_COMMENT = 2000;

/**
 * Maps each turn's last bot text segment to its backend `messageIndex`: USER
 * and BOT alternate from 0, so a bot turn is `2 * users - 1`.
 */

export function computeFeedbackMessageIndices(
  segments: Segment[]
): Map<string, number> {
  const result = new Map<string, number>();
  let userTextCount = 0;
  let lastBotTextIdThisTurn: string | null = null;
  let sawBotSinceLastUser = false;

  for (const seg of segments) {
    if (seg.type === "text" && seg.source === "user") {
      // Close out the previous turn's row before starting a new one.
      if (lastBotTextIdThisTurn != null && sawBotSinceLastUser) {
        result.set(lastBotTextIdThisTurn, 2 * userTextCount - 1);
      }
      userTextCount++;
      lastBotTextIdThisTurn = null;
      sawBotSinceLastUser = false;
    } else if (seg.type === "text" && seg.source === "bot") {
      lastBotTextIdThisTurn = seg.id;
      sawBotSinceLastUser = true;
    }
  }
  if (
    lastBotTextIdThisTurn != null &&
    sawBotSinceLastUser &&
    userTextCount > 0
  ) {
    result.set(lastBotTextIdThisTurn, 2 * userTextCount - 1);
  }
  return result;
}

type Verdict = "none" | "up" | "down";

export const FeedbackRow = ({
  content,
  credits,
  creditsTotal,
  onRate,
}: {
  content: string;
  /** This turn's compute points, when the turn reported any. */
  credits?: number;
  /** Running conversation total, for the tooltip. */
  creditsTotal: number;
  /**
   * Report a thumbs up/down (or its withdrawal), with what the user wrote
   * about a bad reply. Absent when the turn cannot be rated — no signed-in
   * Abacus.AI account, or a turn the platform never saw — and the thumbs are
   * then not shown.
   */
  onRate?: (
    rating: "up" | "down" | "clear",
    comment?: string
  ) => Promise<boolean>;
}): JSX.Element => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const CopyIcon = copied ? Check : Copy;
  const [verdict, setVerdict] = useState<Verdict>("none");
  const [rating, setRating] = useState(false);
  // The "tell us more" box: opens on a thumbs-down, which is already sent —
  // the text is a follow-up, so closing it without writing loses nothing.
  const [askingMore, setAskingMore] = useState(false);
  const [comment, setComment] = useState("");

  // Optimistic: the thumb fills at once and reverts if the report failed, so a
  // slow network never makes the click feel ignored.
  const rate = useCallback(
    (thumb: "up" | "down") => {
      if (onRate == null || rating) return;
      const next: Verdict = verdict === thumb ? "none" : thumb;
      const previous = verdict;
      setVerdict(next);
      setRating(true);
      setAskingMore(false);
      void onRate(next === "none" ? "clear" : next)
        .then((ok) => {
          if (ok) {
            // Ask only once the thumb is on record: a box that opens and then
            // closes on a failed report reads as a glitch.
            if (next === "down") setAskingMore(true);
            return;
          }
          setVerdict(previous);
          toast.error(t("workspace.feedback.failed"));
        })
        .finally(() => setRating(false));
    },
    [onRate, rating, verdict, t]
  );

  const sendComment = useCallback(() => {
    const text = comment.trim().slice(0, MAX_FEEDBACK_COMMENT);
    if (onRate == null || text.length === 0) {
      setAskingMore(false);
      return;
    }
    setRating(true);
    void onRate("down", text)
      .then((ok) => {
        if (ok) {
          setAskingMore(false);
          setComment("");
          return;
        }
        toast.error(t("workspace.feedback.failed"));
      })
      .finally(() => setRating(false));
  }, [comment, onRate, t]);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [content]);

  return (
    <div
      className="flex w-full items-center justify-between gap-2"
      data-id="local-code-feedback-row"
    >
      <div
        className="flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/assistant:opacity-100 group-hover/assistant:opacity-100"
        data-id="local-code-feedback-actions"
      >
        {onRate != null && (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    data-id="local-code-feedback-up"
                    aria-pressed={verdict === "up"}
                    onClick={() => rate("up")}
                    aria-label={t("workspace.feedback.helpful")}
                  />
                }
              >
                <ThumbsUp
                  className={verdict === "up" ? "fill-current" : undefined}
                />
              </TooltipTrigger>
              <TooltipContent side="top">
                {t("workspace.feedback.helpful")}
              </TooltipContent>
            </Tooltip>
            <Popover
              open={askingMore}
              onOpenChange={(open) => {
                if (!open) setAskingMore(false);
              }}
            >
              <div className="relative">
                {/* The thumb cannot be the trigger: it carries the tooltip, and
                    a trigger would toggle the popover on the click that opens it. */}
                <PopoverTrigger
                  render={
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-0"
                    />
                  }
                />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        data-id="local-code-feedback-down"
                        aria-pressed={verdict === "down"}
                        onClick={() => rate("down")}
                        aria-label={t("workspace.feedback.notHelpful")}
                      />
                    }
                  >
                    <ThumbsDown
                      className={
                        verdict === "down" ? "fill-current" : undefined
                      }
                    />
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {t("workspace.feedback.notHelpful")}
                  </TooltipContent>
                </Tooltip>
              </div>
              <PopoverContent
                side="top"
                align="start"
                className="w-80 gap-2"
                data-id="local-code-feedback-more"
              >
                <PopoverTitle>
                  {t("workspace.feedback.tellUsMore")}
                </PopoverTitle>
                <Textarea
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  maxLength={MAX_FEEDBACK_COMMENT}
                  rows={3}
                  placeholder={t("workspace.feedback.tellUsMorePlaceholder")}
                  data-id="local-code-feedback-comment"
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      (event.metaKey || event.ctrlKey)
                    )
                      sendComment();
                  }}
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    data-id="local-code-feedback-skip"
                    onClick={() => setAskingMore(false)}
                  >
                    {t("workspace.feedback.skip")}
                  </Button>
                  <Button
                    size="sm"
                    data-id="local-code-feedback-send"
                    disabled={rating || comment.trim().length === 0}
                    onClick={sendComment}
                  >
                    {t("workspace.feedback.send")}
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                data-id="local-code-feedback-copy"
                onClick={copy}
                aria-label={
                  copied
                    ? t("workspace.feedback.copied")
                    : t("workspace.feedback.copy")
                }
              />
            }
          >
            <CopyIcon />
          </TooltipTrigger>
          <TooltipContent side="top">
            {copied
              ? t("workspace.feedback.copied")
              : t("workspace.feedback.copy")}
          </TooltipContent>
        </Tooltip>
      </div>
      {credits != null && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="text-muted-foreground cursor-default text-[0.625rem] opacity-60 transition-opacity hover:opacity-100" />
            }
          >
            {t("workspace.credits.used", { credits: credits.toFixed(2) })}
          </TooltipTrigger>
          <TooltipContent side="top">
            {`${t("workspace.credits.thisTurn", { credits: credits.toFixed(2) })}\n${t("workspace.credits.total", { credits: creditsTotal.toFixed(2) })}`}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};
