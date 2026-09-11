import { RefreshCw } from "lucide-react";
import { type JSX } from "react";
import { useTranslation } from "react-i18next";

import { useUpdateInstall, useUpdateStatus } from "../common/use-update-status";
import { Button } from "../ui/button";

/**
 * The update as one strip above the composer: quiet progress while downloading,
 * a retry on failure, one click once a build is on disk. Stands down for the
 * critical-update dialog and the stalled-install banner.
 */
export const ComposerUpdateStrip = (): JSX.Element | null => {
  const { t } = useTranslation();
  const status = useUpdateStatus();
  const { installing, install } = useUpdateInstall(status);

  if (status == null || (!status.available && !status.downloaded)) return null;
  if (status.criticalUpdate || status.installStalled) return null;

  const version = status.updateInfo?.version;

  if (!status.downloaded && status.error != null && !status.downloading) {
    return (
      <div className="mx-4 mb-2" data-id="update-strip-failed">
        <Button
          variant="ghost"
          data-id="update-strip-retry"
          disabled={status.checking}
          onClick={() => void window.api.update.check()}
          className="text-muted-foreground border-border/80 bg-card/80 h-8 w-full justify-start gap-2 rounded-md border px-3 text-xs"
          title={status.error}
        >
          <RefreshCw
            className={`size-3.5 ${status.checking ? "animate-spin" : ""}`}
          />
          <span className="truncate">
            {status.checking
              ? t("updatePill.retrying")
              : t("updatePill.failed")}
          </span>
        </Button>
      </div>
    );
  }

  if (!status.downloaded) {
    const percent = Math.round(status.progress?.percent ?? 0);

    return (
      <div
        className="border-border/80 bg-card/80 mx-4 mb-2 overflow-hidden rounded-md border"
        data-id="update-strip-downloading"
        role="status"
      >
        <div className="text-muted-foreground flex h-8 items-center gap-2 px-3 text-xs">
          <RefreshCw className="size-3.5 animate-spin" />
          <span className="truncate">
            {t("updatePill.downloading", { percent })}
          </span>
        </div>
        <div className="bg-muted h-0.5">
          <div
            className="bg-primary h-full transition-[width]"
            style={{ width: `${percent}%` }}
            data-id="update-strip-progress"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-4 mb-2">
      <Button
        variant="ghost"
        data-id="update-strip"
        disabled={installing}
        onClick={install}
        title={version ? t("updatePill.tooltip", { version }) : undefined}
        className="border-primary/20 bg-primary/10 text-primary hover:bg-primary/15 h-8 w-full justify-start gap-2 rounded-md border px-3 text-xs disabled:opacity-70"
      >
        <RefreshCw className={`size-3.5 ${installing ? "animate-spin" : ""}`} />
        <span className="truncate">
          {installing ? t("updatePill.installing") : t("updatePill.relaunch")}
        </span>
        {!installing && version != null && (
          <span className="text-muted-foreground ms-auto">{version}</span>
        )}
      </Button>
    </div>
  );
};
