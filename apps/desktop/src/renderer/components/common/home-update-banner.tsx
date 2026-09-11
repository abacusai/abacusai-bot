import { useNavigate } from "@tanstack/react-router";
import { RefreshCw, X } from "lucide-react";
import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../ui/button";
import { useUpdateInstall, useUpdateStatus } from "./use-update-status";

/**
 * The update banner at the top of the bot maker, which has no composer for
 * the usual strip (chat/composer-update-strip.tsx) to sit above. Same states
 * and standing rules as the strip; the ready state adds a dismiss.
 */
export const HomeUpdateBanner = (): JSX.Element | null => {
  const { t } = useTranslation();
  const status = useUpdateStatus();
  const { installing, install } = useUpdateInstall(status);
  const [dismissed, setDismissed] = useState(false);
  const navigate = useNavigate();

  if (status == null || (!status.available && !status.downloaded)) return null;
  if (status.criticalUpdate || status.installStalled || dismissed) return null;

  if (!status.downloaded && status.error != null && !status.downloading) {
    return (
      <Button
        variant="outline"
        data-id="home-update-banner-failed"
        disabled={status.checking}
        onClick={() => void window.api.update.check()}
        title={status.error}
        className="text-muted-foreground mx-6 mt-6 h-11 justify-start gap-2 self-stretch rounded-xl"
      >
        <RefreshCw className={status.checking ? "animate-spin" : undefined} />
        {status.checking ? t("updatePill.retrying") : t("updatePill.failed")}
      </Button>
    );
  }

  if (!status.downloaded) {
    const percent = Math.round(status.progress?.percent ?? 0);

    return (
      <div
        className="border-border bg-card mx-6 mt-6 self-stretch overflow-hidden rounded-xl border"
        data-id="home-update-banner-downloading"
        role="status"
      >
        <div className="text-muted-foreground flex items-center gap-2 p-3 text-sm">
          <RefreshCw className="size-4 animate-spin" />
          {t("updatePill.downloading", { percent })}
        </div>
        <div className="bg-muted h-0.5">
          <div
            className="bg-primary h-full transition-[width]"
            style={{ width: `${percent}%` }}
            data-id="home-update-banner-progress"
          />
        </div>
      </div>
    );
  }

  const version = status.updateInfo?.version;

  return (
    <div
      className="border-border bg-card mx-6 mt-6 flex items-center gap-3 self-stretch rounded-xl border p-3"
      data-id="home-update-banner"
    >
      <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-full">
        <RefreshCw className={`size-4 ${installing ? "animate-spin" : ""}`} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm font-semibold">
          {t("updateBanner.title")}
        </p>
        <p className="text-muted-foreground truncate text-xs">
          {t("updateBanner.subtitle")}
        </p>
      </div>
      {/* The moment someone wants the changelog is when an update lands. */}
      <Button
        variant="ghost"
        size="sm"
        data-id="home-update-banner-changelog"
        onClick={() => void navigate({ to: "/settings/changelog" })}
        className="text-muted-foreground shrink-0"
      >
        {t("updateBanner.whatsChanged")}
      </Button>
      <Button
        variant="outline"
        size="lg"
        data-id="home-update-banner-install"
        disabled={installing}
        onClick={install}
        title={version ? t("updatePill.tooltip", { version }) : undefined}
        className="text-primary border-primary/30 hover:bg-primary/10 hover:text-primary shrink-0"
      >
        {installing ? t("updatePill.installing") : t("updatePill.relaunch")}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        data-id="home-update-banner-dismiss"
        aria-label={t("updateBanner.dismiss")}
        onClick={() => setDismissed(true)}
        className="text-muted-foreground shrink-0"
      >
        <X />
      </Button>
    </div>
  );
};
