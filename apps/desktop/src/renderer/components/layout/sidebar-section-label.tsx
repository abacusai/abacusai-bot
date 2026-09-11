import { ChevronDown } from "lucide-react";
import { type JSX, type ReactNode } from "react";

import { SidebarGroupLabel } from "../ui/sidebar";

/**
 * A sidebar section's header: a name, a count, and a caret that folds it away.
 * The whole label is the toggle; a caret alone is too small to aim at. The
 * header sits above its section's scroller, never inside it, so it stays on
 * screen without being sticky.
 */
export const SidebarSectionLabel = ({
  label,
  count,
  isOpen,
  onToggle,
  dataId,
  action,
}: {
  label: string;
  count: number;
  isOpen: boolean;
  onToggle: () => void;
  dataId: string;
  /** The section's + button, positioned against the header it belongs to. */
  action?: ReactNode;
}): JSX.Element => {
  const header = (
    <SidebarGroupLabel
      // Base UI merges the component's props over the render element's, so an
      // onClick declared inside `render` is silently dropped.
      render={<button type="button" />}
      onClick={onToggle}
      aria-expanded={isOpen}
      data-id={`${dataId}-toggle`}
      className="hover:text-sidebar-accent-foreground w-full cursor-default gap-1"
    >
      <ChevronDown
        className={`size-3 shrink-0 transition-transform ${isOpen ? "" : "-rotate-90"}`}
        aria-hidden
      />
      <span className="min-w-0 truncate">{label}</span>
      {count > 0 && (
        <span className="text-muted-foreground/70 shrink-0 tabular-nums">
          {count}
        </span>
      )}
    </SidebarGroupLabel>
  );
  if (action == null) return header;
  return (
    <div className="relative shrink-0" data-id={`${dataId}-header`}>
      {header}
      {action}
    </div>
  );
};
