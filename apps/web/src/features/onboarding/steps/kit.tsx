/**
 * The step vocabulary (canvas page 11): a 44 px primary/secondary button, a
 * 32 px quiet link, the title scale (hero 40/48, large 34/42, medium 32/40,
 * default 28/36), a body line and a pill. Thin wrappers over the registry
 * primitives so every step reads the same.
 */
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
    size={variant === "small" ? "default" : "lg"}
    variant={variant === "primary" ? "default" : "secondary"}
    data-variant={variant}
    className={cn("max-[800px]:min-h-11", className)}
    {...props}
  />
);

export const StepLink = ({
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size">) => (
  <Button
    size="sm"
    variant="ghost"
    className={cn("text-muted-foreground", className)}
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

export const Pill = ({
  dot,
  children,
}: {
  /** The dot's colour (a CSS colour). */
  dot: string;
  children: ReactNode;
}) => (
  <span className="onboarding-pill" style={{ "--pill-dot": dot } as never}>
    <i aria-hidden="true" />
    {children}
  </span>
);

export const ConnectedMark = ({ children }: { children: ReactNode }) => (
  <span className="onboarding-connected">
    <i aria-hidden="true" />
    {children}
  </span>
);
