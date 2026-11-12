import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "#renderer/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
} from "#renderer/ui/popover";

/**
 * A small card pinned beside one control that says what to do with it: the
 * welcome tour's stops and the first-run hint at Send. Escape or the close
 * button dismisses it; it never takes focus from what the person is doing.
 */
export const CoachCard = ({
  anchor,
  title,
  body,
  footer,
  side = "right",
  align = "center",
  onDismiss,
  marker,
}: {
  anchor: HTMLElement;
  title: ReactNode;
  body: ReactNode;
  footer?: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  onDismiss(): void;
  /** A data attribute naming the card, for tests and screenshots. */
  marker: Record<`data-${string}`, string>;
}) => {
  const { t } = useTranslation();
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [onDismiss]);
  return (
    <Popover
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <PopoverContent
        anchor={anchor}
        side={side}
        align={align}
        sideOffset={12}
        initialFocus={false}
        finalFocus={false}
        className="max-w-[calc(100vw-32px)] p-4"
        {...marker}
      >
        <div className="flex items-center justify-between gap-3">
          <PopoverTitle>{title}</PopoverTitle>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("common.close")}
            onClick={onDismiss}
          >
            <X />
          </Button>
        </div>
        <PopoverDescription>{body}</PopoverDescription>
        {footer}
      </PopoverContent>
    </Popover>
  );
};
