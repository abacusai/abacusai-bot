import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AreaPage,
  GroupCard,
  SettingRow,
} from "#renderer/components/form-kit/page";
import { followNotices } from "#renderer/data/queries/live";
import { getLogDump } from "#renderer/lib/log-ring";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { showError, showInfo } from "#renderer/lib/toast";
import { useAppContext, errorText } from "#renderer/lib/use-app-context";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
} from "#renderer/ui/alert-dialog";
import { Button } from "#renderer/ui/button";
import type { UpdateStatus } from "@abacus-ai/contract/update";
export const updatePhase = (
  status: UpdateStatus | undefined,
  clicked = false
) => {
  if (!status) return "loading";
  if (status.installStalled) return "stalled";
  if (status.installing) return "installing";
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
        setLive(
          status.installing && !status.installStalled
            ? {
                ...status,
                error: null,
                failedPhase: null,
                installStalled: false,
              }
            : status
        );
        if (
          (!status.installing || status.installStalled) &&
          (status.failedPhase === "install" || status.installStalled)
        ) {
          setClicked(false);
          setInstallError(null);
        }
      },
      abort.signal
    );
    return () => abort.abort();
  }, [transport]);
  const incoming = live ?? seed.data;
  const status =
    incoming?.installing && !incoming.installStalled
      ? { ...incoming, error: null, failedPhase: null, installStalled: false }
      : incoming;
  const install = async () => {
    setClicked(true);
    setInstallError(null);
    if (status)
      setLive({
        ...status,
        error: null,
        failedPhase: null,
        installStalled: false,
      });
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
            platform:
              info.data?.platform === "darwin"
                ? "macOS"
                : info.data?.platform === "win32"
                  ? "Windows"
                  : info.data?.platform === "linux"
                    ? "Linux"
                    : "",
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
        <SettingRow id="logs" title={t("phase5.logs")}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void transport.client.system.logs
                .save({ rendererLogs: getLogDump() })
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
    !!update.status?.error ||
    !!update.installError ||
    update.clicked ||
    !!update.status?.installing;
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
            disabled={update.phase === "installing"}
            onClick={() => void update.install()}
          >
            {t(
              update.phase === "installing"
                ? "phase5.updates.installing"
                : update.phase === "installFailed"
                  ? "phase5.tryAgain"
                  : "phase5.restartNow"
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/** Public shell-end-slot consumer; shell owns placement and compact overflow. */

export const UpdatePillButton = ({
  status,
  clicked = false,
  installError = null,
  onInstall,
  onCheck,
}: {
  status: UpdateStatus | undefined;
  clicked?: boolean;
  installError?: string | null;
  onInstall(): Promise<unknown>;
  onCheck(): Promise<unknown>;
}) => {
  const { t } = useTranslation();
  const phase = installError ? "installFailed" : updatePhase(status, clicked);
  if (
    !status ||
    status.criticalUpdate ||
    status.installStalled ||
    ["loading", "latest", "checking", "checkFailed"].includes(phase)
  )
    return null;
  const retry = phase === "downloadFailed";
  const install = phase === "downloaded" || phase === "installFailed";
  const label = retry
    ? "phase5.retry"
    : install
      ? phase === "installFailed"
        ? "phase5.tryAgain"
        : "phase5.relaunch"
      : `phase5.updates.${phase}`;
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={!retry && !install}
      title={
        install
          ? t("phase5.updates.downloaded", {
              version: status.updateInfo?.version,
            })
          : undefined
      }
      onClick={() => {
        if (retry) void onCheck();
        else if (install) void onInstall();
      }}
    >
      {retry && <span>{t("phase5.updates.downloadFailed")}</span>}
      {t(label, { percent: Math.round(status.progress?.percent ?? 0) })}
    </Button>
  );
};

/** Global title-bar action, consumed by the root route through the shell API. */
export const useUpdatePillAction = () => {
  const { t } = useTranslation();
  const update = useUpdateStatus();
  const phase = update.phase;
  const visible =
    update.status &&
    !update.status.criticalUpdate &&
    !update.status.installStalled &&
    !["loading", "latest", "checking", "checkFailed"].includes(phase);
  const retry = phase === "downloadFailed";
  const install = phase === "downloaded" || phase === "installFailed";
  const label = retry
    ? "phase5.retry"
    : install
      ? phase === "installFailed"
        ? "phase5.tryAgain"
        : "phase5.relaunch"
      : `phase5.updates.${phase}`;
  return visible
    ? [
        {
          id: "update",
          label: t(label, {
            percent: Math.round(update.status?.progress?.percent ?? 0),
          }),
          render: (
            <UpdatePillButton
              status={update.status}
              clicked={update.clicked}
              installError={update.installError}
              onInstall={update.install}
              onCheck={update.check}
            />
          ),
          onSelect: () => {
            if (retry) void update.check();
            else if (install) void update.install();
          },
        },
      ]
    : [];
};
