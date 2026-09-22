import { Mic, Square } from "lucide-react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/cn";
import { useDictation } from "../../voice/use-dictation";
import { Button, Spinner } from "../ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

/**
 * The composer's microphone: press to talk, press again to put the words in
 * the box. The first use downloads the speech model, and the tooltip says so.
 */
export const DictationButton = ({
  onText,
  className,
}: {
  onText: (text: string) => void;
  className?: string;
}): JSX.Element => {
  const { t } = useTranslation();
  const { phase, level, download, error, toggle } = useDictation(onText);

  const label =
    phase === "recording"
      ? t("workspace.voice.stop")
      : phase === "transcribing"
        ? download != null
          ? t("workspace.voice.downloading", {
              percent:
                download.totalBytes > 0
                  ? Math.round(
                      (download.loadedBytes / download.totalBytes) * 100
                    )
                  : 0,
            })
          : t("workspace.voice.transcribing")
        : error != null
          ? t(`workspace.voice.errors.${error}`)
          : t("workspace.voice.start");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            data-id="local-code-dictation-btn"
            data-phase={phase}
            aria-label={label}
            aria-pressed={phase === "recording"}
            disabled={phase === "transcribing"}
            onClick={toggle}
            className={cn(
              phase === "recording" && "text-red-500 hover:text-red-500",
              error != null && phase === "idle" && "text-destructive",
              className
            )}
            style={
              phase === "recording"
                ? { boxShadow: `0 0 0 ${2 + level * 6}px rgba(239,68,68,0.25)` }
                : undefined
            }
          />
        }
      >
        {phase === "transcribing" ? (
          <Spinner fontSize={12} />
        ) : phase === "recording" ? (
          <Square className="fill-current" />
        ) : (
          <Mic />
        )}
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
};
