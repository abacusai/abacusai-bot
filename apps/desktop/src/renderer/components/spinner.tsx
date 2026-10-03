import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";

import { Spinner as RegistrySpinner } from "#renderer/ui/spinner";

/** Localized application boundary around the unmodified registry primitive. */
export const Spinner = (props: ComponentProps<typeof RegistrySpinner>) => {
  const { t } = useTranslation();
  return <RegistrySpinner aria-label={t("common.loading")} {...props} />;
};
