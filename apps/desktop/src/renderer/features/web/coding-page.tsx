/**
 * The web app's Sessions area. Coding runs on the user's own computer: with
 * their desktop attached the page opens the coding view, which that desktop
 * serves; otherwise it says how to attach one.
 */
import { useTranslation } from "react-i18next";

import { EmptyState } from "#renderer/components/empty-state";
import { useCapability } from "#renderer/lib/capabilities";
import { codingViewUrl } from "#renderer/lib/web-app";
import { buttonVariants } from "#renderer/ui/button";

/** Where the desktop app is downloaded; a public page, the same for everyone. */
export const DESKTOP_DOWNLOAD_URL = "https://bot.abacus.ai";

export const CodingPage = () => {
  const { t } = useTranslation();
  const attached = useCapability("sessions");
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6">
      <EmptyState
        icon="sessions"
        title={t("web.coding.title")}
        description={t(
          attached ? "web.coding.bodyAttached" : "web.coding.body"
        )}
        action={
          <a
            className={buttonVariants()}
            href={attached ? codingViewUrl() : DESKTOP_DOWNLOAD_URL}
            {...(attached ? {} : { target: "_blank", rel: "noopener" })}
          >
            {t(attached ? "web.coding.open" : "web.coding.download")}
          </a>
        }
      />
    </div>
  );
};
