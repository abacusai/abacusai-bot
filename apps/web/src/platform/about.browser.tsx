import { useTranslation } from "react-i18next";

import { AreaPage } from "#renderer/components/form-kit/page";
import { LicenseSection } from "#renderer/features/settings/license-section";
export const AboutPage = () => {
  const { t } = useTranslation();
  return (
    <AreaPage title={t("settings.pages.about")}>
      <LicenseSection />
    </AreaPage>
  );
};
