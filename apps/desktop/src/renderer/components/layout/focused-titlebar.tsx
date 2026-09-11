import { ArrowLeft } from "lucide-react";
import { type CSSProperties, type JSX, type ReactNode } from "react";

import {
  TITLEBAR_END_INSET,
  TITLEBAR_START_INSET,
} from "../../lib/window-chrome";
import { Button } from "../ui/button";

export type FocusedTitleBarProps = {
  /** The visible, accessible page title. */
  title: ReactNode;
  /** Deterministic destination owned by the focused route family. */
  onBack: () => void;
  actions?: ReactNode;
  leading?: ReactNode;
  startInset?: number | string;
  actionsLabel?: string;
  backLabel?: string;
  titleId?: string;
};

/** Window chrome for routes that deliberately live outside the coding shell. */
export function FocusedTitleBar({
  title,
  onBack,
  actions,
  leading,
  startInset = TITLEBAR_START_INSET,
  actionsLabel = "Page actions",
  backLabel = "Back",
  titleId,
}: FocusedTitleBarProps): JSX.Element {
  return (
    <header
      data-slot="focused-titlebar"
      className="border-border bg-background/80 h-(--workspace-topbar-height) shrink-0 border-b backdrop-blur-xl"
      style={{ WebkitAppRegion: "drag" } as CSSProperties}
    >
      <div
        className="flex h-full min-w-0 items-center gap-2"
        style={{
          paddingLeft: startInset,
          paddingRight: TITLEBAR_END_INSET,
        }}
      >
        {leading}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-id="focused-route-back"
          aria-label={backLabel}
          title={backLabel}
          onClick={onBack}
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
        >
          <ArrowLeft className="rtl:rotate-180" />
        </Button>

        <h1
          id={titleId}
          className="min-w-0 truncate text-xs font-medium"
          data-slot="focused-title"
        >
          {title}
        </h1>

        {actions != null && (
          <nav
            aria-label={actionsLabel}
            className="ms-auto flex shrink-0 items-center gap-1"
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          >
            {actions}
          </nav>
        )}
      </div>
    </header>
  );
}
