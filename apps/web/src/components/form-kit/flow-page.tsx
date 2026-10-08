import type { ComponentProps, ReactNode } from "react";

import { cn } from "#renderer/lib/cn";

/** Shared standalone account/setup layout, including touch targets before the shell mounts. */
export const FlowContent = ({
  media,
  children,
  className,
}: {
  media?: ReactNode;
  children: ReactNode;
  className?: string;
}) => (
  <div
    className={cn(
      "flex w-full max-w-sm flex-col items-center gap-6 text-center [&_[data-slot=button]]:max-[800px]:min-h-11 [&_[data-slot=input]]:max-[800px]:min-h-11 [&_[data-slot=input]]:max-[800px]:text-base",
      className
    )}
  >
    {media}
    {children}
  </div>
);

export const FlowHeader = ({
  title,
  description,
}: {
  title: string;
  description?: string;
}) => (
  <div className="flex flex-col gap-2">
    <h1 className="page-title text-balance">{title}</h1>
    {description && (
      <p className="text-muted-foreground text-sm/relaxed text-pretty">
        {description}
      </p>
    )}
  </div>
);

export const FlowPage = ({
  media,
  children,
  className,
  ...props
}: ComponentProps<"main"> & { media?: ReactNode }) => (
  <main
    className={cn(
      "bg-background text-foreground fixed inset-0 z-50 flex flex-col items-center overflow-y-auto px-(--page-gutter) pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]",
      className
    )}
    {...props}
  >
    <FlowContent media={media} className="my-auto shrink-0">
      {children}
    </FlowContent>
  </main>
);
