import type { ReactNode } from "react";

import { cn } from "#renderer/lib/cn";
import { Badge } from "#renderer/ui/badge";
export const AreaPage = ({
  title,
  description,
  children,
  actions,
  testId,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
  testId?: string;
}) => (
  <div
    className="size-full min-w-0 overflow-auto overscroll-contain"
    data-testid={testId}
  >
    <main className="content-col page-column">
      <PageToolbar>
        <h1 className="page-title">{title}</h1>
        {actions}
      </PageToolbar>
      {description && (
        <p className="text-muted-foreground phone:text-[15px] text-[13px]">
          {description}
        </p>
      )}
      {children}
    </main>
  </div>
);
export const GroupCard = ({
  children,
  title,
  className,
}: {
  children: ReactNode;
  title?: string;
  className?: string;
}) => (
  <div
    className={cn(
      "bg-card border-border/60 phone:border-0 phone:px-0 flex min-w-0 flex-col divide-y rounded-(--pane-radius) border px-1",
      className
    )}
  >
    {title && (
      <h2 className="phone:px-4 phone:text-[15px] px-3 py-3 text-[13px] font-semibold">
        {title}
      </h2>
    )}
    {children}
  </div>
);
export const SettingRow = ({
  id,
  title,
  detail,
  media,
  children,
}: {
  id: string;
  title: string;
  detail?: string;
  /** A mark before the title (a provider's). */
  media?: ReactNode;
  children?: ReactNode;
}) => (
  <div data-setting-id={id} className="setting-row @container/setting">
    {media != null && <div className="shrink-0">{media}</div>}
    <div className="min-w-0 flex-[1_1_140px]">
      <div
        id={`${id}-label`}
        className="phone:text-[15px] text-[13px] font-medium break-words"
      >
        {title}
      </div>
      {detail && (
        <p
          id={`${id}-detail`}
          className="text-muted-foreground phone:text-[13px] phone:line-clamp-2 phone:mt-0.5 text-xs break-words"
        >
          {detail}
        </p>
      )}
    </div>
    <div className="setting-controls flex max-w-full min-w-0 flex-wrap items-center justify-end gap-2 [&>[data-slot=native-select-wrapper]]:max-w-full [&>[data-slot=native-select-wrapper]]:min-w-0">
      {children}
    </div>
  </div>
);
export const StatePill = ({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning";
}) => (
  <Badge
    variant="secondary"
    className={
      tone === "success"
        ? "border border-[var(--bots-done)] bg-transparent text-[var(--bots-done)]"
        : tone === "warning"
          ? "border border-[var(--bots-attention)] bg-transparent text-[var(--bots-attention)]"
          : undefined
    }
  >
    {children}
  </Badge>
);

export const PageToolbar = ({ children }: { children: ReactNode }) => (
  <div data-slot="page-toolbar" className="page-toolbar">
    {children}
  </div>
);
