import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { useConnectFlow, ConnectorFieldsDialog } from "#next/features/library";
import {
  AccountPage,
  AccountSearch,
  InviteDialog,
} from "#next/features/settings";
import { TopBarSlot } from "#next/features/shell";

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
