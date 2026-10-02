/**
 * An area's empty state (spec 01 §4): registry `Empty` + the area glyph +
 * translated copy, with an optional action. Every placeholder route renders
 * one in phase 1.
 */
import type { ReactNode } from "react";

import { AppIcon, type AppIconName } from "#renderer/components/app-icon";
import { cn } from "#renderer/lib/cn";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#renderer/ui/empty";

export interface EmptyStateProps {
  icon?: AppIconName;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

export const EmptyState = ({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) => (
  <Empty
    className={cn("max-w-full min-w-0", className)}
    data-testid="empty-state"
  >
    <EmptyHeader className="max-w-full min-w-0">
      {icon != null && (
        <EmptyMedia variant="icon">
          <AppIcon name={icon} size={18} />
        </EmptyMedia>
      )}
      <EmptyTitle className="max-w-full break-words">{title}</EmptyTitle>
      {description != null && (
        <EmptyDescription className="max-w-full break-words">
          {description}
        </EmptyDescription>
      )}
    </EmptyHeader>
    {action != null && (
      <EmptyContent className="min-w-0 flex-wrap">{action}</EmptyContent>
    )}
  </Empty>
);
