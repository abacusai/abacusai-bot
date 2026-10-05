/**
 * The row atoms every sidebar is built from (spec 01 §7.3). No registry
 * `sidebar` (its provider owns ⌘B); rows are registry `Item`s rendered as
 * links, with `Badge`, `Skeleton`, `Collapsible` and icon `Button`s.
 */
import { ChevronRight } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "#renderer/lib/cn";
import type { NavType } from "#renderer/lib/motion";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { Badge as RegistryBadge } from "#renderer/ui/badge";
import { Button } from "#renderer/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#renderer/ui/collapsible";
import { Item, ItemContent, ItemMedia, ItemTitle } from "#renderer/ui/item";
import { Skeleton as RegistrySkeleton } from "#renderer/ui/skeleton";

const Root = ({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) => (
  <nav
    aria-label={label}
    data-slot="nav-list"
    className={cn("flex min-h-0 flex-1 flex-col px-2 pb-2", className)}
  >
    {children}
  </nav>
);

const Header = ({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) => (
  <div className="flex h-(--sidebar-header-h) shrink-0 items-center gap-1 pr-1 pl-2">
    <h2 className="text-sidebar-foreground flex-1 truncate text-[15px] font-semibold">
      {title}
    </h2>
    {children}
  </div>
);

const Group = ({
  label,
  icon,
  meta,
  children,
  open,
  onOpenChange,
}: {
  label: string;
  icon?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  /** Given: the group collapses (workspace groups). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) => {
  const heading = (
    <>
      {icon}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {meta != null && <span className="shrink-0">{meta}</span>}
    </>
  );
  const headingClass =
    "flex h-(--row-h) w-full items-center gap-1.5 px-2 text-xs text-muted-foreground";
  if (open === undefined)
    return (
      <div role="group" aria-label={label} className="mt-2 first:mt-0">
        {label && <div className={headingClass}>{heading}</div>}
        <div className="flex flex-col">{children}</div>
      </div>
    );
  return (
    <Collapsible
      open={open}
      onOpenChange={onOpenChange}
      className="mt-2 first:mt-0"
    >
      <CollapsibleTrigger
        className={cn(
          headingClass,
          "group/trigger hover:text-sidebar-foreground rounded-md"
        )}
      >
        <ChevronRight className="size-3 transition-transform group-data-[panel-open]/trigger:rotate-90" />
        {heading}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
};

interface NavListItemProps {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, unknown>;
  active?: boolean;
  transition?: NavType | "none";
  media?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  indent?: boolean;
  /** Native tooltip (the strip shows names this way). */
  hint?: string;
  className?: string;
}

const NavItem = ({
  to,
  params,
  search,
  active = false,
  // Unset: the router infers the type (new → entity is nav-forward, entity
  // → entity nav-lateral); a forced lateral would flatten a drill-in.
  transition,
  media,
  title,
  meta,
  trailing,
  indent = false,
  hint,
  className,
}: NavListItemProps) => (
  <Item
    size="xs"
    data-active={active || undefined}
    aria-current={active ? "page" : undefined}
    title={hint}
    className={cn(
      "text-sidebar-foreground hover:bg-sidebar-accent/60 data-active:bg-sidebar-accent phone:rounded-xl phone:px-3 phone:text-[15px] h-(--row-h) flex-nowrap gap-2 rounded-lg px-2 py-0 text-[13px]",
      indent && "pl-7",
      className
    )}
    render={
      <AppLink
        {...({ to, params, search, transition } as ComponentProps<
          typeof AppLink
        >)}
      />
    }
  >
    {media != null && <ItemMedia className="shrink-0">{media}</ItemMedia>}
    <ItemContent className="min-w-0 flex-1">
      <ItemTitle className="block w-full truncate font-normal">
        {title}
      </ItemTitle>
    </ItemContent>
    {meta != null && (
      <span className="text-sidebar-foreground/70 shrink-0 text-[11px]">
        {meta}
      </span>
    )}
    {trailing}
  </Item>
);

const Action = ({
  label,
  children,
  ...props
}: { label: string; children: ReactNode } & ComponentProps<typeof Button>) => (
  <Button
    variant="ghost"
    size="icon-sm"
    nativeButton={props.render == null}
    aria-label={label}
    title={label}
    className="text-muted-foreground hover:text-sidebar-foreground"
    {...props}
  >
    {children}
  </Button>
);

const Badge = (props: ComponentProps<typeof RegistryBadge>) => (
  <RegistryBadge variant="secondary" {...props} />
);

const Skeleton = ({ rows = 6 }: { rows?: number }) => (
  <div
    data-testid="nav-list-skeleton"
    aria-busy="true"
    className="flex flex-col gap-2 px-2 pt-3"
  >
    {Array.from({ length: rows }, (_, index) => (
      <div key={index} className="flex h-(--row-h) items-center gap-2">
        <RegistrySkeleton className="size-5 shrink-0 rounded-md" />
        <RegistrySkeleton className={index % 2 ? "h-3 w-3/5" : "h-3 w-4/5"} />
      </div>
    ))}
  </div>
);

/**
 * The rows of a flat list, on the row pitch (32 px, no gap; V5). Links in a
 * `<nav>` need no list role: `role="list"` over bare links is an ARIA error
 * (`aria-required-children`, Claude impl r1 #9).
 */
const Rows = ({ children }: { children: ReactNode }) => (
  <div data-slot="nav-list-rows" className="flex flex-col pt-2">
    {children}
  </div>
);

const ErrorRow = ({
  message,
  retryLabel,
  onRetry,
}: {
  message: string;
  retryLabel: string;
  onRetry: () => void;
}) => (
  <div
    role="alert"
    className="text-muted-foreground flex items-center gap-2 px-2 pt-2 text-xs"
  >
    <span className="flex-1">{message}</span>
    <Button variant="outline" size="xs" onClick={onRetry}>
      {retryLabel}
    </Button>
  </div>
);

export const NavList = {
  Root,
  Header,
  Group,
  Item: NavItem,
  Rows,
  Action,
  Badge,
  Skeleton,
  Error: ErrorRow,
};
