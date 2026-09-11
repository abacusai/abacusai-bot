import { Outlet } from "@tanstack/react-router";
import { type CSSProperties, type JSX, type ReactNode, useId } from "react";

import { TITLEBAR_START_INSET } from "../../lib/window-chrome";
import { AbacusBotLogo } from "../brand/abacus-bot-logo";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { FocusedTitleBar } from "./focused-titlebar";

export type FocusedToolLayoutProps = {
  title: ReactNode;
  onBack: () => void;
  actions?: ReactNode;
  actionsLabel?: string;
  backLabel?: string;
  /** A page-owned navigation or list rail, not the workspace sidebar. */
  sidebar?: ReactNode;
  sidebarLabel?: string;
  /** Omit to render the matched child route through TanStack Router's Outlet. */
  children?: ReactNode;
};

type FocusedToolFrameProps = FocusedToolLayoutProps & { titleId: string };

function FocusedToolFrame({
  title,
  onBack,
  actions,
  actionsLabel,
  backLabel,
  sidebar,
  sidebarLabel = "Page navigation",
  children,
  titleId,
}: FocusedToolFrameProps): JSX.Element {
  const { isMobile, openMobile } = useSidebar();
  const sidebarShown = isMobile ? openMobile : sidebar != null;

  return (
    <>
      {sidebar != null && (
        <Sidebar collapsible="offcanvas">
          <aside
            data-slot="focused-page-sidebar"
            aria-label={sidebarLabel}
            className="scrollbar-autohide flex h-full min-h-0 flex-col"
          >
            <SidebarHeader
              className="border-border h-(--workspace-topbar-height) shrink-0 justify-center border-b p-0 pe-2"
              style={
                {
                  paddingLeft: isMobile ? 8 : TITLEBAR_START_INSET,
                  WebkitAppRegion: "drag",
                } as CSSProperties
              }
            >
              <div className="flex min-w-0 items-center justify-between gap-1">
                <AbacusBotLogo className="min-w-0" />
                {isMobile && (
                  <SidebarTrigger
                    size="icon"
                    className="text-muted-foreground ms-auto"
                    style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
                  />
                )}
              </div>
            </SidebarHeader>
            <SidebarContent className="scroll-fade-y scrollbar-autohide overflow-x-hidden">
              {sidebar}
            </SidebarContent>
          </aside>
        </Sidebar>
      )}

      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <FocusedTitleBar
          title={title}
          titleId={titleId}
          onBack={onBack}
          actions={actions}
          actionsLabel={actionsLabel}
          backLabel={backLabel}
          startInset={sidebarShown && !isMobile ? 16 : TITLEBAR_START_INSET}
          leading={
            sidebar != null && isMobile && !sidebarShown ? (
              <div
                className="flex items-center gap-1"
                style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
              >
                <AbacusBotLogo markOnly />
                <SidebarTrigger size="icon" />
              </div>
            ) : undefined
          }
        />

        <div
          data-slot="focused-page-content"
          className="@container min-h-0 min-w-0 flex-1 overflow-hidden"
        >
          {children === undefined ? <Outlet /> : children}
        </div>
      </SidebarInset>
    </>
  );
}

/** Focused route shell with no workspace, terminal, or inspector chrome. */
export function FocusedToolLayout(props: FocusedToolLayoutProps): JSX.Element {
  const titleId = useId();

  return (
    <section
      data-slot="focused-tool-layout"
      aria-labelledby={titleId}
      className="bg-background text-foreground h-full min-h-0 min-w-0 overflow-hidden"
    >
      <SidebarProvider
        open
        className="h-full min-h-0 overflow-hidden"
        style={{ "--sidebar-width": "15rem" } as CSSProperties}
      >
        <FocusedToolFrame {...props} titleId={titleId} />
      </SidebarProvider>
    </section>
  );
}
