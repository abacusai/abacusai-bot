import type { ReactNode } from "react";

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
  <div className="size-full min-w-0 overflow-auto" data-testid={testId}>
    <main className="mx-auto flex w-[min(680px,calc(100%-48px))] min-w-0 flex-col gap-4 pt-10 pb-16">
      <PageToolbar>
        <h1 className="min-w-0 text-[22px] font-semibold break-words">
          {title}
        </h1>
        {actions}
      </PageToolbar>
      {description && (
        <p className="text-muted-foreground mb-2 text-[13px]">{description}</p>
      )}
      {children}
    </main>
  </div>
);
export const GroupCard = ({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) => (
  <div className="bg-card border-border/60 flex min-w-0 flex-col divide-y rounded-xl border px-1">
    {title && <h2 className="px-3 py-3 text-[13px] font-semibold">{title}</h2>}
    {children}
  </div>
);
export const SettingRow = ({
  id,
  title,
  detail,
  children,
}: {
  id: string;
  title: string;
  detail?: string;
  children?: ReactNode;
}) => (
  <div
    data-setting-id={id}
    className="@container/setting flex min-h-[52px] min-w-0 flex-wrap items-center justify-between gap-3 px-3 py-3"
  >
    <div className="min-w-0 flex-[1_1_140px]">
      <div id={`${id}-label`} className="text-[13px] font-medium break-words">
        {title}
      </div>
      {detail && (
        <p
          id={`${id}-detail`}
          className="text-muted-foreground text-xs break-words"
        >
          {detail}
        </p>
      )}
    </div>
    <div className="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-2 [&>[data-slot=native-select-wrapper]]:max-w-full [&>[data-slot=native-select-wrapper]]:min-w-0">
      {children}
    </div>
  </div>
);
export const StatePill = ({ children }: { children: ReactNode }) => (
  <Badge variant="secondary">{children}</Badge>
);

export const PageToolbar = ({ children }: { children: ReactNode }) => (
  <div
    data-slot="page-toolbar"
    className="flex min-w-0 flex-wrap items-center justify-between gap-3 [&>button]:shrink-0"
  >
    {children}
  </div>
);
