import type { JSX, ReactNode } from "react";

import { cn } from "../../lib/cn";

export const ShimmerText = ({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element => (
  <span className={cn("shimmer inline-block", className)}>{children}</span>
);
