/**
 * A turn's files as a card under what the bot said (spec 03 §11.3a, canvas
 * BotChat attachment rows): "Files {n}", three rows then Show all. A row
 * opens the file (read-only preview) or URL; its secondary button reveals the
 * file in the folder or opens the URL in the browser. Nothing opens itself.
 */
import {
  ExternalLink,
  File,
  FileImage,
  FileText,
  FolderOpen,
  Globe,
  Presentation,
  Sheet,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "#next/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "#next/ui/tooltip";

import { categorizeFile, fileExtension } from "./paths";

export interface DeliverableItem {
  path: string;
  label?: string;
  isUrl: boolean;
}

export interface DeliverablesCardProps {
  items: readonly DeliverableItem[];
  onOpen(item: DeliverableItem): void;
  onReveal(item: DeliverableItem): void;
  onOpenUrl(item: DeliverableItem): void;
}

const VISIBLE_ROWS = 3;

const iconFor = (item: DeliverableItem) => {
  if (item.isUrl) return Globe;
  const ext = fileExtension(item.path);
  if (ext === "xlsx" || ext === "xls" || ext === "csv") return Sheet;
  switch (categorizeFile(item.path)) {
    case "image":
      return FileImage;
    case "presentation":
      return Presentation;
    case "markdown":
    case "text":
    case "document":
      return FileText;
    default:
      return File;
  }
};

const nameOf = (item: DeliverableItem): string =>
  item.label ??
  (item.isUrl ? item.path : (item.path.split(/[\\/]/).pop() ?? item.path));

export const DeliverablesCard = ({
  items,
  onOpen,
  onReveal,
  onOpenUrl,
}: DeliverablesCardProps) => {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  if (items.length === 0) return null;
  const visible = showAll ? items : items.slice(0, VISIBLE_ROWS);
  const hidden = items.length - visible.length;
  return (
    <div
      className="w-full max-w-[min(520px,85%)] min-w-0 rounded-xl border bg-[var(--chat-surface,var(--muted))]/40 px-2.5 pt-1.5 pb-2"
      data-slot="deliverables-card"
    >
      <div className="flex items-center gap-2 pb-1">
        <span className="text-muted-foreground text-xs font-medium">
          {t("bots.chat.deliverables.files")}
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {items.length}
        </span>
      </div>
      <ul className="flex flex-col gap-0.5">
        {visible.map((item, index) => {
          const Icon = iconFor(item);
          const secondary = item.isUrl
            ? t("bots.chat.deliverables.openInBrowser")
            : t("bots.chat.deliverables.showInFolder");
          return (
            <li
              key={`${item.path}-${index}`}
              className="hover:bg-muted/60 flex min-w-0 items-center gap-1 rounded-md"
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="sm"
                      data-slot="deliverable-open"
                      className="min-w-0 flex-1 justify-start gap-2 px-1.5 font-normal hover:bg-transparent"
                      onClick={() => onOpen(item)}
                    />
                  }
                >
                  <Icon aria-hidden className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{nameOf(item)}</span>
                </TooltipTrigger>
                <TooltipContent>{item.path}</TooltipContent>
              </Tooltip>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={secondary}
                title={secondary}
                data-slot="deliverable-locate"
                className="text-muted-foreground shrink-0"
                onClick={() => (item.isUrl ? onOpenUrl(item) : onReveal(item))}
              >
                {item.isUrl ? <ExternalLink /> : <FolderOpen />}
              </Button>
            </li>
          );
        })}
      </ul>
      {items.length > VISIBLE_ROWS && (
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground mt-0.5 px-1.5"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll
            ? t("bots.chat.deliverables.showLess")
            : t("bots.chat.deliverables.showAll", { count: hidden })}
        </Button>
      )}
    </div>
  );
};
