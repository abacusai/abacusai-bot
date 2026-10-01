import type { ReactNode } from "react";

import { Badge } from "#next/ui/badge";
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
  <div className="size-full overflow-auto" data-testid={testId}>
    <main className="mx-auto flex w-[min(680px,calc(100%-48px))] flex-col gap-4 pt-10 pb-16">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[22px] font-semibold">{title}</h1>
        {actions}
      </div>
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
  <div className="bg-card flex flex-col divide-y rounded-[14px] px-1">
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
    className="flex min-h-[52px] items-center justify-between gap-3 px-3 py-2"
  >
    <div className="min-w-0 flex-1">
      <div id={`${id}-label`} className="text-[13px] font-medium">
        {title}
      </div>
      {detail && (
        <p id={`${id}-detail`} className="text-muted-foreground text-xs">
          {detail}
        </p>
      )}
    </div>
    <div className="flex shrink-0 items-center gap-2">{children}</div>
  </div>
);
export const StatePill = ({ children }: { children: ReactNode }) => (
  <Badge variant="secondary">{children}</Badge>
);
