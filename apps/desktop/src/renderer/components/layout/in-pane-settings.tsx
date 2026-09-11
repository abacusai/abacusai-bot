import { Link, Outlet, useMatches, useNavigate } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import { type JSX } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui/button";

/**
 * The capabilities family ("what can the agent reach") as tabs over the
 * workspace pane rather than the focused settings window, so looking at your
 * tools does not close your chat.
 */

const TABS = [
  { to: "/settings/tools", labelKey: "capabilities.tabs.tools" },
  { to: "/settings/mcp", labelKey: "capabilities.tabs.mcp" },
  { to: "/settings/skills", labelKey: "skills.title" },
  { to: "/settings/connectors", labelKey: "sidebarNav.connectors" },
] as const;

/**
 * The pane has no Back chrome, so the tab strip carries it; otherwise the only
 * way out of a toolset is to pick a tab, which loses your place.
 */
const useBackTo = (): string | undefined =>
  useMatches({
    select: (matches) =>
      [...matches]
        .reverse()
        .map((match) => (match.staticData as { backTo?: string }).backTo)
        .find((backTo) => backTo != null),
  });

export const CapabilitiesPane = (): JSX.Element => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const backTo = useBackTo();

  return (
    <div className="flex h-full min-h-0 flex-col" data-id="capabilities-pane">
      <nav
        aria-label={t("capabilities.tabs.label")}
        className="border-border flex shrink-0 items-center gap-1 border-b px-3 py-1.5"
      >
        {backTo != null && (
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground size-6"
            aria-label={t("common.back")}
            data-id="capabilities-pane-back"
            onClick={() => void navigate({ to: backTo })}
          >
            <ChevronLeft />
          </Button>
        )}
        {TABS.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            data-id={`capabilities-tab-${tab.to.split("/").pop()!}`}
            className="text-muted-foreground hover:text-foreground rounded-md px-2.5 py-1 text-xs transition-colors"
            activeProps={{ className: "bg-accent text-accent-foreground" }}
          >
            {t(tab.labelKey)}
          </Link>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
};

/** The same pane without tabs, for a destination that has no sub-pages. */
export const PlainPane = (): JSX.Element => (
  <div className="h-full min-h-0 overflow-hidden" data-id="in-pane-settings">
    <Outlet />
  </div>
);
