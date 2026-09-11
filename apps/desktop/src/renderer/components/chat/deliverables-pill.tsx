import { ExternalLink, FolderOpen } from "lucide-react";
import { useState, type JSX, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";

import {
  useResolveWorkspacePath,
  useWorkspaceRoot,
} from "../../hooks/use-workspace-root";
import { fileIconFor } from "../../utils/file-icon";
import {
  containmentRootFor,
  openAbsoluteFileInPreview,
  openUrlInPreview,
} from "../../utils/preview-utils";
import { Button } from "../ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { basename } from "./component-tools";
import type { TurnDeliverable } from "./deliverables";

/** Rows shown before "+N more"; past six the card is a directory listing. */
const VISIBLE_ROWS = 6;

/**
 * The turn's files, as a card under what the agent said. A bot's chat hides
 * the tool log, so this is how a doc a bot made reaches the person who asked.
 * A click opens the file (preview pane, or the OS app); nothing opens itself.
 */
export const DeliverablesPill = ({
  items,
}: {
  items: TurnDeliverable[];
}): JSX.Element | null => {
  const { t } = useTranslation();
  const resolvePath = useResolveWorkspacePath();
  const workspacePath = useWorkspaceRoot();
  const [showAll, setShowAll] = useState(false);

  if (items.length === 0) return null;

  const visible = showAll ? items : items.slice(0, VISIBLE_ROWS);
  const hidden = items.length - visible.length;

  const open = (item: TurnDeliverable): void => {
    if (item.isUrl) {
      openUrlInPreview(item.path);
      return;
    }
    // Resolve first — a workspace-relative path would otherwise fail the read.
    const absolute = resolvePath(item.path);
    void openAbsoluteFileInPreview(
      absolute,
      containmentRootFor(absolute, workspacePath)
    );
  };

  const locate = (item: TurnDeliverable, event: MouseEvent): void => {
    event.stopPropagation();
    if (item.isUrl) void window.api.openExternal(item.path);
    else void window.api.showItemInFolder(resolvePath(item.path));
  };

  return (
    <div
      className="border-border/70 bg-muted/30 w-full min-w-0 rounded-xl border px-2.5 pt-1.5 pb-2"
      data-id="deliverables-card"
    >
      <div className="flex items-center gap-2 pb-1">
        <span className="text-muted-foreground text-xs font-medium">
          {t("deliverables.files")}
        </span>
        <span className="text-muted-foreground/70 text-xs tabular-nums">
          {items.length}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        {visible.map((item, idx) => {
          const Icon = fileIconFor(item.path);
          const name =
            item.label ?? (item.isUrl ? item.path : basename(item.path));
          const locateLabel = item.isUrl
            ? t("deliverables.openInBrowser")
            : t("deliverables.showInFolder");
          return (
            <div
              key={`${item.path}-${idx}`}
              className="hover:bg-accent/40 flex min-w-0 items-center gap-1 rounded-md"
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => open(item)}
                      data-id="deliverable-open"
                      className="text-foreground min-w-0 flex-1 justify-start gap-2 px-1.5 font-normal hover:bg-transparent"
                    />
                  }
                >
                  <Icon className="text-primary/80 size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{name}</span>
                </TooltipTrigger>
                <TooltipContent>{item.path}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={(event) => locate(item, event)}
                      aria-label={locateLabel}
                      data-id="deliverable-locate"
                      className="text-muted-foreground shrink-0"
                    />
                  }
                >
                  {item.isUrl ? <ExternalLink /> : <FolderOpen />}
                </TooltipTrigger>
                <TooltipContent>{locateLabel}</TooltipContent>
              </Tooltip>
            </div>
          );
        })}
      </div>
      {(hidden > 0 || showAll) && items.length > VISIBLE_ROWS && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => setShowAll((value) => !value)}
          className="text-muted-foreground mt-0.5 px-1.5"
          data-id="deliverables-toggle"
        >
          {showAll
            ? t("deliverables.showLess")
            : t("deliverables.showMore", { count: hidden })}
        </Button>
      )}
    </div>
  );
};
