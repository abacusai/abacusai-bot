import type { ComponentProps } from "react";

import { cn } from "#renderer/lib/cn";
import { Button } from "#renderer/ui/button";

export const TitleBarGroup = ({
  className,
  ...props
}: ComponentProps<"div">) => (
  <div className={cn("titlebar-group", className)} {...props} />
);
export const TitleBarSpacer = () => (
  <span aria-hidden="true" className="min-w-0 flex-1" />
);
export const TitleBarIconButton = ({
  label,
  className,
  ...props
}: { label: string } & ComponentProps<typeof Button>) => (
  <Button
    variant="ghost"
    size="icon-sm"
    aria-label={label}
    title={label}
    className={cn("titlebar-nodrag titlebar-icon-button", className)}
    {...props}
  />
);
