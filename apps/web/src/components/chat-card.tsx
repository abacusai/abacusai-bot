import type { ReactNode } from "react";

import { cn } from "#renderer/lib/cn";

/**
 * A card in the chat (a failed turn, the credit wall, a payment or phone
 * step): an icon tile, a bold title and its line, then the card's own
 * sections and buttons. One calm frame for all of them, never an alarm's
 * colours. Sections stack without rules or padding of their own.
 */
export const ChatCard = ({
  icon,
  title,
  description,
  children,
  className,
}: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) => (
  <div
    className={cn(
      "bg-background flex w-full min-w-0 gap-3 rounded-xl border p-3.5 text-sm shadow-xs",
      className
    )}
  >
    <span
      aria-hidden
      className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-[9px] [&_svg]:size-4"
    >
      {icon}
    </span>
    <div className="flex min-w-0 flex-1 flex-col gap-3 *:empty:hidden">
      <div className="flex min-h-8 flex-col justify-center gap-0.5">
        <h2 className="font-semibold">{title}</h2>
        {description != null && description !== "" && (
          <p className="text-muted-foreground">{description}</p>
        )}
      </div>
      {children != null && (
        <div className="flex min-w-0 flex-col gap-3 *:p-0 *:empty:hidden">
          {children}
        </div>
      )}
    </div>
  </div>
);
