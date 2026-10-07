import type { UpdateStatus } from "@abacus-ai/contract/update";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AreaPage,
  GroupCard,
  SettingRow,
} from "#renderer/components/form-kit/page";
import { followNotices } from "#renderer/data/queries/notices";
import { useMutation } from "#renderer/data/query-client";
import type { Transport } from "#renderer/data/transport";
import { getLogDump } from "#renderer/lib/log-ring";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { showInfo } from "#renderer/lib/toast";
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

import { LicenseSection } from "./license-section";
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
/**
 * The update status: `update.status` once, then each status `update.events`
 * pushes (whole statuses; the first yield is the current one), written into
 * that query by one follower per document. The pill, the critical dialog
 * and the About page share both. The follower is not the query's fetch, so
 * the query settles and an awaited `invalidateQueries()` resolves; it runs
 * while any of them is mounted and starts again on a remount. Its stream is
 * `followNotices`': an end or a transient error reopens it after a second,
 * a replaced socket at once (its first yield is the status then, so a
 * reconnect needs no refetch), and a final code or a closed transport stops
 * it.
 */
export const updateStatusQuery = (transport: Transport) =>
  transport.orpc.update.status.queryOptions({
    input: {},
    staleTime: Infinity,
  });

const followers = new WeakMap<
  QueryClient,
  { mounted: number; abort: AbortController }
>();

const useUpdateFollower = (
  transport: Transport,
  queryClient: QueryClient
): void => {
  useEffect(() => {
    let follower = followers.get(queryClient);
    if (follower == null) {
      const started = { mounted: 0, abort: new AbortController() };
      followers.set(queryClient, started);
      const { queryKey } = updateStatusQuery(transport);
      void followNotices(
        transport,
        ({ signal }) => transport.client.update.events({}, { signal }),
        (status) => queryClient.setQueryData(queryKey, status),
        started.abort.signal
      );
      follower = started;
    }
    const current = follower;
    current.mounted += 1;
    return () => {
      current.mounted -= 1;
      if (current.mounted > 0) return;
      current.abort.abort();
      if (followers.get(queryClient) === current) followers.delete(queryClient);
    };
  }, [transport, queryClient]);
};

/** While installing, an earlier failure is not shown. */
const presented = (status: UpdateStatus | undefined) =>
  status?.installing && !status.installStalled
    ? { ...status, error: null, failedPhase: null, installStalled: false }
    : status;

export const useUpdateStatus = () => {
  const { transport, queryClient } = useAppContext();
  const live = updateStatusQuery(transport);
  const { data: incoming } = useQuery(live);
  useUpdateFollower(transport, queryClient);
  const [clicked, setClicked] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  // An install that failed or stalled releases the pressed state, once per
  // status that says so.
  const [seen, setSeen] = useState(incoming);
  if (seen !== incoming) {
    setSeen(incoming);
    if (
      incoming != null &&
      (!incoming.installing || incoming.installStalled) &&
      (incoming.failedPhase === "install" || incoming.installStalled)
    ) {
      setClicked(false);
      setInstallError(null);
    }
  }
  const status = presented(incoming);
  const install = useMutation(
    transport.orpc.update.install.mutationOptions({
      onMutate: () => {
        setClicked(true);
        setInstallError(null);
        if (status)
          queryClient.setQueryData(live.queryKey, {
            ...status,
            error: null,
            failedPhase: null,
            installStalled: false,
          });
      },
      onError: (e) => {
        setClicked(false);
        setInstallError(errorText(e));
      },
    })
  );
  const check = useMutation(
    transport.orpc.update.check.mutationOptions({ meta: { errorToast: true } })
  );
  return {
    status,
    clicked,
    install: () => install.mutate({}),
    installError,
    phase: installError ? "installFailed" : updatePhase(status, clicked),
    check: () => check.mutate({}),
  };
};
export const AboutPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const info = useQuery(transport.orpc.system.info.queryOptions({ input: {} }));
  const update = useUpdateStatus();
  const saveLogs = useMutation(
    transport.orpc.system.logs.save.mutationOptions({
      onSuccess: (result) => {
        if (result.filePath)
          showInfo(t("phase5.logsSaved", { path: result.filePath }));
      },
      meta: { errorToast: true },
    })
  );
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
          <Button size="sm" onClick={() => update.check()}>
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
            <Button size="sm" onClick={() => update.install()}>
              {t(
                update.phase === "installFailed"
                  ? "phase5.tryAgain"
                  : "phase5.relaunch"
              )}
            </Button>
          )}
          {["checkFailed", "downloadFailed"].includes(update.phase) && (
            <Button size="sm" onClick={() => update.check()}>
              {t("phase5.retry")}
            </Button>
          )}
        </SettingRow>
        <SettingRow id="logs" title={t("phase5.logs")}>
          <Button
            size="sm"
            variant="secondary"
            disabled={saveLogs.isPending}
            onClick={() => saveLogs.mutate({ rendererLogs: getLogDump() })}
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
      <LicenseSection />
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
    if (open && remaining === 0 && !paused) update.install();
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
            onClick={() => update.install()}
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
  onInstall(): void;
  onCheck(): void;
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
        if (retry) onCheck();
        else if (install) onInstall();
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
            if (retry) update.check();
            else if (install) update.install();
          },
        },
      ]
    : [];
};
