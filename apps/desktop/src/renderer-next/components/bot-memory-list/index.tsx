import { useTranslation } from "react-i18next";

import { Button } from "#next/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "#next/ui/tooltip";

/** Presentational memory rows, shared by Bots and Settings. */
export const BotMemoryList = ({
  entries,
  onForget,
  pendingId,
}: {
  entries: readonly { id: string; entry: string }[];
  onForget(row: { id: string; entry: string }): void;
  pendingId?: string;
}) => {
  const { t } = useTranslation();
  if (!entries.length)
    return (
      <p className="text-muted-foreground text-sm">
        {t("bots.panel.memory.empty")}
      </p>
    );
  return entries.map((row) => (
    <div key={row.id} className="flex min-h-11 items-center gap-2 border-b">
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              tabIndex={0}
              className="min-w-0 flex-1 truncate text-[13px]"
            />
          }
        >
          {row.entry}
        </TooltipTrigger>
        <TooltipContent>{row.entry}</TooltipContent>
      </Tooltip>
      <Button
        variant="ghost"
        size="sm"
        disabled={pendingId === row.id}
        aria-label={t("bots.panel.forgetEntry", { entry: row.entry })}
        onClick={() => onForget(row)}
      >
        {t("bots.panel.memory.forget")}
      </Button>
    </div>
  ));
};
