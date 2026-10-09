import type { ComponentProps, ReactNode } from "react";

import { cn } from "#renderer/lib/cn";
import { Button } from "#renderer/ui/button";

export const StepButton = ({
  variant = "primary",
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size"> & {
  variant?: "primary" | "secondary" | "small";
}) => (
  <Button
    size="default"
    variant={variant === "primary" ? "default" : "ghost"}
    data-variant={variant}
    className={cn(
      variant === "small" ? "h-8 px-3 text-[13px]" : "h-10 px-5 text-sm",
      variant !== "primary" && "text-muted-foreground",
      className
    )}
    {...props}
  />
);

export const StepLink = ({
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size">) => (
  <Button
    size="default"
    variant="ghost"
    className={cn("text-muted-foreground text-[13px]", className)}
    {...props}
  />
);

/** A row of quiet links with the canvas's middle dots between them. */
export const StepLinks = ({
  className,
  children,
}: {
  className?: string;
  children: ReactNode[];
}) => (
  <div className={cn("onboarding-links", className)}>
    {children
      .filter((child) => child != null && child !== false)
      .map((child, index) => (
        <span key={index} className="contents">
          {index > 0 && <span aria-hidden="true">·</span>}
          {child}
        </span>
      ))}
  </div>
);

export const StepTitle = ({
  size,
  className,
  ...props
}: ComponentProps<"h1"> & {
  size?: "hero" | "large" | "medium";
}) => (
  <h1
    tabIndex={-1}
    data-size={size}
    className={cn("onboarding-title", className)}
    {...props}
  />
);

export const StepBody = ({ className, ...props }: ComponentProps<"p">) => (
  <p className={cn("onboarding-body", className)} {...props} />
);

export const ConnectedMark = ({ children }: { children: ReactNode }) => (
  <span className="onboarding-connected">
    <i aria-hidden="true" />
    {children}
  </span>
);
