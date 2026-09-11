import { Check, Copy } from "lucide-react";
/**
 * Per-turn feedback row: thumbs, copy, and the compute-points chip, rendered
 * under the LAST bot text segment of a settled turn so a turn gets one row.
 */
import { useCallback, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { Segment } from "../../conversation";
import { Button } from "../ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

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

export const FeedbackRow = ({
  content,
  credits,
  creditsTotal,
}: {
  content: string;
  /** This turn's compute points, when the turn reported any. */
  credits?: number;
  /** Running conversation total, for the tooltip. */
  creditsTotal: number;
}): JSX.Element => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const CopyIcon = copied ? Check : Copy;

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
