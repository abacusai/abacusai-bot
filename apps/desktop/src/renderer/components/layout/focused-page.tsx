import { type ComponentProps, type JSX, type ReactNode } from "react";

import { cn } from "../../lib/cn";

type FocusedPageProps = ComponentProps<"div">;

/** The non-coding route body. The route titlebar owns the page title. */
export function FocusedPage({
  children,
  className,
  ...props
}: FocusedPageProps): JSX.Element {
  return (
    <div
      data-slot="focused-page"
      className={cn(
        "@container flex h-full min-h-0 min-w-0 flex-col",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

type FocusedPageToolbarProps = {
  children: ReactNode;
  className?: string;
};

export function FocusedPageToolbar({
  children,
  className,
}: FocusedPageToolbarProps): JSX.Element {
  return (
    <div
      data-slot="focused-page-toolbar"
      className="border-border shrink-0 border-b"
    >
      <div
        className={cn(
          "mx-auto flex w-full max-w-4xl flex-wrap items-center gap-3 px-4 py-3 @2xl:px-6",
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}

type FocusedPageBodyProps = {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
};

export function FocusedPageBody({
  children,
  className,
  contentClassName,
}: FocusedPageBodyProps): JSX.Element {
  return (
    <div
      data-slot="focused-page-scroll-area"
      className={cn(
        "scroll-fade-y scrollbar-autohide min-h-0 min-w-0 flex-1 overflow-y-auto",
        className
      )}
    >
      <div
        data-slot="focused-page-body"
        className={cn(
          "mx-auto min-h-full w-full max-w-4xl space-y-6 p-4 @2xl:p-6",
          contentClassName
        )}
      >
        {children}
      </div>
    </div>
  );
}

type FocusedPageLeadProps = {
  description: ReactNode;
  actions?: ReactNode;
  className?: string;
};

/** Supporting copy and page actions without repeating the route title. */
export function FocusedPageLead({
  description,
  actions,
  className,
}: FocusedPageLeadProps): JSX.Element {
  return (
    <div
      data-slot="focused-page-lead"
      className={cn(
        "mb-6 flex flex-col items-start justify-between gap-4 @xl:flex-row",
        className
      )}
    >
      <p className="text-muted-foreground max-w-2xl text-sm">{description}</p>
      {actions != null && (
        <div className="flex shrink-0 items-center gap-2 self-stretch @xl:self-auto">
          {actions}
        </div>
      )}
    </div>
  );
}
