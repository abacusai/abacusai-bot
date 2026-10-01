/**
 * An area's empty state (spec 01 §4): registry `Empty` + the area glyph +
 * translated copy, with an optional action. Every placeholder route renders
 * one in phase 1.
 */
import type { ReactNode } from "react";

import { AppIcon, type AppIconName } from "#renderer/components/app-icon";
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
  <Empty className={className} data-testid="empty-state">
    <EmptyHeader>
      {icon != null && (
        <EmptyMedia variant="icon">
          <AppIcon name={icon} size={18} />
        </EmptyMedia>
      )}
      <EmptyTitle>{title}</EmptyTitle>
      {description != null && (
        <EmptyDescription>{description}</EmptyDescription>
      )}
    </EmptyHeader>
    {action != null && <EmptyContent>{action}</EmptyContent>}
  </Empty>
);
