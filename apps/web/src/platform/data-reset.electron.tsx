import { useTranslation } from "react-i18next";

import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import { GroupCard, SettingRow } from "#renderer/components/form-kit/page";
import { useAppContext } from "#renderer/lib/use-app-context";

export const LocalDataReset = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  return (
    <GroupCard>
      <SettingRow
        id="deleteAllData"
        title={t("settings.deleteAllData.title")}
        detail={t("settings.deleteAllData.detail")}
      >
        <ConfirmAction
          title={t("settings.deleteAllData.title")}
          description={t("settings.deleteAllData.confirmation")}
          label={t("settings.deleteAllData.confirm")}
          onConfirm={() =>
            transport.client.system.deleteAllData({
              confirmation: "DELETE_ALL_LOCAL_DATA",
            })
          }
        >
          {t("settings.deleteAllData.title")}
        </ConfirmAction>
      </SettingRow>
    </GroupCard>
  );
};
