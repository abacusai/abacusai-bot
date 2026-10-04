/** Public library navigation and feature components. */
import { useMatchRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { NavList } from "#renderer/components/nav-list";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { LIBRARY_PAGES } from "#renderer/lib/navigation/areas";
import { showError } from "#renderer/lib/toast";
import { Button } from "#renderer/ui/button";

export const LibrarySidebar = () => {
  const { t } = useTranslation();
  const matchRoute = useMatchRoute();
  const queue = usePrefs().onboardingPairing ?? [];
  const update = useUpdatePrefs();
  return (
    <NavList.Root label={t("library.sidebar.label")}>
      <NavList.Header title={t("library.sidebar.label")} />
      {queue.length > 0 && (
        <div role="status" className="flex flex-col gap-2 p-3 text-xs">
          <p>{t("phase5.pairingPending")}</p>
          {queue.map((platform) => (
            <Button
              key={platform}
              size="sm"
              variant="secondary"
              nativeButton={false}
              render={
                <AppLink
                  to="/library/messaging"
                  search={{ platform }}
                  transition="none"
                />
              }
            >
              {t("phase5.finishPairing", {
                platform: t(`messaging.platforms.${platform}`),
              })}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void update({ onboardingPairing: [] }).catch(() =>
                showError(t("phase5.saveFailed"))
              )
            }
          >
            {t("phase5.dismiss")}
          </Button>
        </div>
      )}
      <NavList.Rows>
        {LIBRARY_PAGES.map((page) => (
          <NavList.Item
            key={page}
            to={`/library/${page}`}
            active={
              matchRoute({ to: `/library/${page}`, fuzzy: true } as never) !==
              false
            }
            title={t(`library.pages.${page}`)}
          />
        ))}
      </NavList.Rows>
    </NavList.Root>
  );
};

export {
  ConnectorsPage,
  ConnectorSheet,
  ConnectorFieldsDialog,
} from "./connectors";
export { MessagingPage } from "./messaging";
export { McpPage } from "./mcp";
export { SkillsPage, ToolsPage, ToolsetPage } from "./skills-tools";
export { MessagingSearch, McpSearch, SkillsSearch } from "./search";
/** @public Connect flow shared with phase 6 onboarding. */
export { startConnect, useConnectFlow } from "./connect-flow";
export { LibraryGlobals } from "./globals";
