import { RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { AppLink } from "#renderer/lib/navigation/app-link";
import { Button } from "#renderer/ui/button";

import { UpdatePillButton, updateVisible, useUpdateStatus } from "./updates";

import "./update-notice.css";

type Update = ReturnType<typeof useUpdateStatus>;

export const UpdateNotice = ({
  update,
  placement,
}: {
  update: Update;
  placement: "page" | "composer";
}) => {
  const { t } = useTranslation();
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const version = update.status?.updateInfo?.version ?? "";
  const ready = update.phase === "downloaded";
  if (
    !updateVisible(update.status, update.phase) ||
    (placement === "page" && ready && dismissedVersion === version)
  )
    return null;
  const percent = Math.max(
    0,
    Math.min(100, Math.round(update.status?.progress?.percent ?? 0))
  );
  return (
    <section
      data-slot={`${placement}-update`}
      className={placement === "page" ? "mx-4 mt-3 mb-2 shrink-0" : "mb-2"}
      aria-label={t("phase5.settings.updates")}
    >
      <div className="bg-card border-border overflow-hidden rounded-xl border">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
          <RefreshCw
            aria-hidden
            className={`text-muted-foreground size-4 shrink-0 ${["downloading", "installing"].includes(update.phase) ? "animate-spin" : ""}`}
          />
          <div className="min-w-0 flex-1 basis-40">
            <p className="font-medium">
              {ready
                ? t("updateBanner.title")
                : t(`phase5.updates.${update.phase}`, { version, percent })}
            </p>
            {placement === "page" && ready && (
              <p className="text-muted-foreground text-xs">
                {t("updateBanner.subtitle")}
              </p>
            )}
            {(update.installError || update.status?.error) && (
              <p
                className="text-muted-foreground text-xs break-words"
                role="alert"
              >
                {update.installError ?? update.status?.error}
              </p>
            )}
          </div>
          {placement === "page" && ready && (
            <Button
              variant="ghost"
              size="sm"
              nativeButton={false}
              render={<AppLink to="/settings/about/changelog" />}
            >
              {t("updateBanner.whatsChanged")}
            </Button>
          )}
          <UpdatePillButton
            status={update.status}
            clicked={update.clicked}
            installError={update.installError}
            onInstall={update.install}
            onCheck={update.check}
          />
          {placement === "page" && ready && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("updateBanner.dismiss")}
              onClick={() => setDismissedVersion(version)}
            >
              <X aria-hidden />
            </Button>
          )}
        </div>
        {update.phase === "downloading" && (
          <div
            className="bg-muted h-0.5"
            role="progressbar"
            aria-label={t("phase5.updates.downloading", { percent })}
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="bg-primary h-full"
              style={{ width: `${percent}%` }}
            />
          </div>
        )}
      </div>
    </section>
  );
};

export const PageUpdateNotice = () => (
  <UpdateNotice update={useUpdateStatus()} placement="page" />
);
export const ComposerUpdateNotice = () => (
  <div data-slot="composer-update-owner">
    <UpdateNotice update={useUpdateStatus()} placement="composer" />
  </div>
);
export const RailUpdatePill = () => {
  const update = useUpdateStatus();
  return (
    <UpdatePillButton
      compact
      status={update.status}
      clicked={update.clicked}
      installError={update.installError}
      onInstall={update.install}
      onCheck={update.check}
    />
  );
};
