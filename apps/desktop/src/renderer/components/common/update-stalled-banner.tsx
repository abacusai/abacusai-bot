import { useTranslation } from "react-i18next";

import { useUpdateStatus } from "./use-update-status";

/**
 * The one state the update pill cannot express: the install was handed to the
 * platform updater and the app never quit, so clicking the pill again will
 * not help. The user has to quit and reopen, and nothing else on screen is
 * going to tell them that.
 */
export const UpdateStalledBanner = () => {
  const { t } = useTranslation();
  const status = useUpdateStatus();

  if (status?.installStalled !== true) return null;

  return (
    <div
      data-id="update-banner"
      role="alert"
      className="border-destructive/20 bg-destructive/10 text-destructive flex items-center justify-center gap-3 border-b px-4 py-2 text-xs"
    >
      <span data-id="update-banner-stalled-msg">
        {t("updateBanner.stalled")}
      </span>
    </div>
  );
};
