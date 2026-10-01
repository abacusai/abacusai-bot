import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { useConnectFlow } from "#renderer/features/library/connect-flow";
import { ConnectorFieldsDialog } from "#renderer/features/library/connectors";
import { AccountPage } from "#renderer/features/settings/account-usage";
import { InviteDialog } from "#renderer/features/settings/invite";
import { AccountSearch } from "#renderer/features/settings/search";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";

const AccountSettingsRoute = () => {
  const { t } = useTranslation();
  const { invite } = Route.useSearch();
  const flow = useConnectFlow();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("settings.sidebar.label")}
        </span>
      </TopBarSlot>
      <AccountPage />
      {invite && (
        <InviteDialog
          key={invite}
          channel={invite}
          connectGmail={() => flow.start("abacus-gmailuser")}
        />
      )}
      <ConnectorFieldsDialog />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/account")({
  validateSearch: AccountSearch,
  component: AccountSettingsRoute,
});
