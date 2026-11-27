/**
 * "Install as app" on a files card row: a page the agent made (a served
 * URL or an html file) gets a launcher entry and opens in a window of its own
 * (desktop only). The host decides what can be installed; decks, PDFs, other
 * files and sites elsewhere never offer it. Once installed, the row opens it.
 */
import { AppWindow } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { followNotice } from "#renderer/data/queries/notices";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { showError, showInfo } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

const PAGE = /\.html?$/i;
/**
 * Every row of the same page (its URL and its file) follows an install; an
 * uninstall from the app's own window comes from the host.
 */
const CHANGED = "abacus-installed-apps-changed";
const LOCAL_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

interface Props {
  /** The row's absolute path, or its URL. */
  target: string;
  sessionId: string | null;
}

const InstallApp = ({ target, sessionId }: Props) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const apps = transport.client.system.artifactApps;
  const [installedId, setInstalledId] = useState<string | null>(null);
  const [installable, setInstallable] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = () =>
      void apps
        .status({ target })
        .then((status) => {
          if (!live) return;
          setInstallable(status.installable);
          setInstalledId(status.installedId);
        })
        .catch(() => undefined);
    refresh();
    window.addEventListener(CHANGED, refresh);
    const abort = new AbortController();
    followNotice(
      "system",
      transport,
      (event) => {
        if (event.type === "installed-apps-changed") refresh();
      },
      abort.signal
    );
    return () => {
      live = false;
      abort.abort();
      window.removeEventListener(CHANGED, refresh);
    };
  }, [apps, target, transport]);
  const run = () => {
    setBusy(true);
    const done = () => setBusy(false);
    if (installedId != null) {
      void apps
        .open({ id: installedId })
        .catch(() => showError(t("phase5.failed")))
        .finally(done);
      return;
    }
    void apps
      .install({ target, sessionId })
      .then(({ id }) => {
        setInstalledId(id);
        window.dispatchEvent(new Event(CHANGED));
        showInfo(t("phase5.installedApp"));
        return apps.open({ id });
      })
      // The host's reason (too big, ...) is written for the user.
      .catch((error: unknown) =>
        showError(
          error instanceof Error && error.message !== ""
            ? error.message
            : t("phase5.failed")
        )
      )
      .finally(done);
  };
  if (!installable && installedId == null) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      data-slot="install-app-button"
      className="ml-0.5 shrink-0"
      disabled={busy}
      onClick={run}
    >
      <AppWindow aria-hidden />
      {t(installedId != null ? "phase5.openApp" : "phase5.installApp")}
    </Button>
  );
};

export const InstallAppRowButton = (props: Props) =>
  IS_ELECTRON && (PAGE.test(props.target) || LOCAL_URL.test(props.target)) ? (
    <InstallApp {...props} />
  ) : null;
