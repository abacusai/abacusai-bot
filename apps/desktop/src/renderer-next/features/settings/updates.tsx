import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AreaPage,
  GroupCard,
  SettingRow,
} from "#next/components/form-kit/page";
import { followNotices } from "#next/data/queries/live";
import { AppLink } from "#next/lib/navigation/app-link";
import { showError, showInfo } from "#next/lib/toast";
import { useAppContext, errorText } from "#next/lib/use-app-context";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "#next/ui/alert-dialog";
import { Button } from "#next/ui/button";
import type { UpdateStatus } from "#shared/update";
export const updatePhase = (
  status: UpdateStatus | undefined,
  clicked = false
) => {
  if (!status) return "loading";
  if (status.installStalled) return "stalled";
  if (status.error && status.failedPhase === "install") return "installFailed";
  if (clicked || status.installing) return "installing";
  if (status.checking) return "checking";
  if (status.downloading) return "downloading";
  if (status.downloaded) return "downloaded";
  if (status.error)
    return status.failedPhase === "download" ? "downloadFailed" : "checkFailed";
  return "latest";
};
export const useUpdateStatus = () => {
  const { transport } = useAppContext();
  const seed = useQuery(
    transport.orpc.update.status.queryOptions({ input: {} })
  );
  const [live, setLive] = useState<UpdateStatus | undefined>();
  const [clicked, setClicked] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    void followNotices(
      transport,
      ({ signal }) => transport.client.update.events({}, { signal }),
      (status) => {
        setLive(status);
        if (status.failedPhase === "install" || status.installStalled) {
          setClicked(false);
          setInstallError(null);
        }
      },
      abort.signal
    );
    return () => abort.abort();
  }, [transport]);
  const status = live ?? seed.data;
  const install = async () => {
    setClicked(true);
    setInstallError(null);
    try {
      await transport.client.update.install({});
    } catch (e) {
      setClicked(false);
      setInstallError(errorText(e));
    }
  };
  return {
    status,
    clicked,
    install,
    installError,
    phase: installError ? "installFailed" : updatePhase(status, clicked),
    check: () =>
      transport.client.update.check({}).catch((e) => showError(errorText(e))),
  };
};
export const AboutPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const info = useQuery(transport.orpc.system.info.queryOptions({ input: {} }));
  const update = useUpdateStatus();
  return (
    <AreaPage title={t("settings.pages.about")}>
      <GroupCard>
        <SettingRow
          id="appVersion"
          title={t("onboarding.welcomeTitle")}
          detail={t("phase5.version", {
            version: info.data?.appVersion ?? "",
            platform: info.data?.platform ?? "",
          })}
        >
          <Button size="sm" onClick={() => void update.check()}>
            {t("phase5.checkUpdates")}
          </Button>
          {info.data?.platform === "darwin" && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void transport.client.window.showAbout({})}
            >
              {t("phase5.appInfo")}
            </Button>
          )}
        </SettingRow>
        <SettingRow
          id="updates"
          title={t(`phase5.updates.${update.phase}`, {
            version: update.status?.updateInfo?.version,
            percent: Math.round(update.status?.progress?.percent ?? 0),
          })}
          detail={update.installError ?? update.status?.error ?? undefined}
        >
          {["downloaded", "installFailed"].includes(update.phase) && (
            <Button size="sm" onClick={() => void update.install()}>
              {t(
                update.phase === "installFailed"
                  ? "phase5.tryAgain"
                  : "phase5.relaunch"
              )}
            </Button>
          )}
          {["checkFailed", "downloadFailed"].includes(update.phase) && (
            <Button size="sm" onClick={() => void update.check()}>
              {t("phase5.retry")}
            </Button>
          )}
        </SettingRow>
        <SettingRow id="logs" title={t("phase5.saveLogs")}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void transport.client.system.logs
                .save({ rendererLogs: "" })
                .then((result) => {
                  if (result.filePath)
                    showInfo(t("phase5.logsSaved", { path: result.filePath }));
                })
                .catch((e) => showError(errorText(e)))
            }
          >
            {t("phase5.saveLogs")}
          </Button>
        </SettingRow>
        <SettingRow id="changelog" title={t("phase5.whatsNew")}>
          <Button
            size="sm"
            variant="secondary"
            nativeButton={false}
            render={
              <AppLink
                to="/settings/about/changelog"
                transition="nav-forward"
              />
            }
          >
            {t("phase5.openAction")}
          </Button>
        </SettingRow>
      </GroupCard>
    </AreaPage>
  );
};
export const CriticalUpdateDialog = () => {
  const { t } = useTranslation();
  const update = useUpdateStatus();
  const [remaining, setRemaining] = useState(300);
  const open =
    !!update.status?.criticalUpdate &&
    !!update.status.downloaded &&
    !update.status.installStalled;
  const paused =
    !!update.status?.error || !!update.installError || update.clicked;
  useEffect(() => {
    if (!open || paused) return;
    const timer = setInterval(
      () => setRemaining((seconds) => Math.max(0, seconds - 1)),
      1000
    );
    return () => clearInterval(timer);
  }, [open, paused]);
  useEffect(() => {
    if (!open) {
      // A newly downloaded critical update gets its own countdown.
      // eslint-disable-next-line react/set-state-in-effect
      setRemaining(300);
    }
  }, [open]);
  useEffect(() => {
    if (open && remaining === 0 && !paused) void update.install();
  }, [open, remaining, paused, update]);
  if (update.status?.installStalled)
    return (
      <div role="alert" className="bg-muted border-b px-4 py-2 text-sm">
        {t("phase5.updates.stalled")}
      </div>
    );
  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("phase5.requiredUpdate")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("phase5.requiredUpdateDetail")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {update.status?.error || update.installError ? (
          <p role="alert">{update.installError ?? update.status?.error}</p>
        ) : (
          <p>
            {t("phase5.restartCountdown", {
              time: `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`,
            })}
          </p>
        )}
        <AlertDialogFooter>
          <Button
            disabled={update.clicked}
            onClick={() => void update.install()}
          >
            {t(
              update.clicked ? "phase5.updates.installing" : "phase5.restartNow"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
