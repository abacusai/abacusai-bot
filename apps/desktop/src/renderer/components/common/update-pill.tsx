import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui/button";
import { useUpdateInstall, useUpdateStatus } from "./use-update-status";

/**
 * The title-bar update pill, shown only while the sidebar is hidden. Shows the
 * download too: a large transfer with no surface looks like a broken updater.
 */
export const UpdatePill = () => {
  const { t } = useTranslation();
  const status = useUpdateStatus();
  const { installing, install } = useUpdateInstall(status);

  if (status == null || (!status.downloaded && !status.available)) {
    return null;
  }
  // Stand down for the surfaces that outrank it, like the strip and banner do.
  if (status.criticalUpdate || status.installStalled) return null;

  const version = status.updateInfo?.version;

  if (!status.downloaded && status.error != null && !status.downloading) {
    return (
      <Button
        variant="secondary"
        size="sm"
        data-id="update-pill-failed"
        disabled={status.checking}
        onClick={() => void window.api.update.check()}
        title={status.error}
        className="text-muted-foreground h-6 rounded-full"
      >
        <RefreshCw className={status.checking ? "animate-spin" : undefined} />
        {status.checking ? t("updatePill.retrying") : t("updatePill.failed")}
      </Button>
    );
  }

  if (!status.downloaded) {
    const percent = Math.round(status.progress?.percent ?? 0);

    return (
      <Button
        variant="secondary"
        size="sm"
        disabled
        data-id="update-pill-progress"
        title={version ? t("updatePill.tooltip", { version }) : undefined}
        className="h-6 rounded-full"
      >
        <RefreshCw className="animate-spin" />
        {t("updatePill.downloading", { percent })}
      </Button>
    );
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      data-id="update-pill"
      disabled={installing}
      onClick={install}
      title={version ? t("updatePill.tooltip", { version }) : undefined}
      className="text-primary h-6 rounded-full"
    >
      <RefreshCw className={installing ? "animate-spin" : undefined} />
      <span>
        {installing ? t("updatePill.installing") : t("updatePill.relaunch")}
      </span>
    </Button>
  );
};
