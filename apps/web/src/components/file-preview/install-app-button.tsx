/**
 * "Install as app" on a files card row: a page the agent made (a served
 * URL or an html file) gets a launcher entry and opens in a window of its own
 * (desktop only). The host decides what can be installed; decks, PDFs, other
 * files and sites elsewhere never offer it. Once installed, the row opens it.
 * Its ⋯ menu has "Send a copy": the page as one html file, without its data.
 */
import type { DeliverableKind } from "@abacus-ai/contract/deliverables";
import { AppWindow, FileDown, MoreHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { IS_ELECTRON } from "#renderer/lib/platform";
import { showError, showInfo } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#renderer/ui/dropdown-menu";

const PAGE = /\.html?$/i;
/**
 * Every row of the same page (its URL and its file) follows an install; an
 * install or uninstall elsewhere (the app's own window) comes from the host,
 * passed on by the shell (InstalledAppsHost).
 */
export const INSTALLED_APPS_CHANGED = "abacus-installed-apps-changed";
const CHANGED = INSTALLED_APPS_CHANGED;
const LOCAL_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;

interface Props {
  /** The row's absolute path, or its URL. */
  target: string;
  sessionId: string | null;
  /** What the agent said the page is; else the host's guess from the page. */
  kind?: DeliverableKind;
}

const InstallApp = ({ target, sessionId, kind }: Props) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const apps = transport.client.system.artifactApps;
  // Its app when kept (a tool or game, from when it was presented) or installed.
  const [appId, setAppId] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);
  const [installable, setInstallable] = useState(false);
  // A page to read (a site, a document): Share stays the row's main action
  // and Install waits in its ⋯ menu. A tool or game shows the button.
  const [site, setSite] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = () =>
      void apps
        .status({ target })
        .then((status) => {
          if (!live) return;
          setInstallable(status.installable);
          setAppId(status.appId);
          setInstalled(status.installed);
          setSite(
            kind != null
              ? kind === "site" || kind === "document"
              : status.kind === "site"
          );
        })
        .catch(() => undefined);
    refresh();
    window.addEventListener(CHANGED, refresh);
    return () => {
      live = false;
      window.removeEventListener(CHANGED, refresh);
    };
  }, [apps, target, kind]);
  const failed = (error: unknown) =>
    // The host's reason (too big, ...) is written for the user.
    showError((error instanceof Error && error.message) || t("phase5.failed"));
  const run = () => {
    setBusy(true);
    const done = () => setBusy(false);
    if (installed && appId != null) {
      void apps
        .open({ id: appId })
        .catch(() => showError(t("phase5.failed")))
        .finally(done);
      return;
    }
    void apps
      .install({ target, sessionId })
      .then(({ id }) => {
        setAppId(id);
        setInstalled(true);
        window.dispatchEvent(new Event(CHANGED));
        showInfo(t("phase5.installedApp"));
        return apps.open({ id });
      })
      .catch(failed)
      .finally(done);
  };
  const sendCopy = () =>
    void apps
      .sendCopy({ target })
      .then(({ saved }) => {
        if (saved) showInfo(t("phase5.copySaved"));
      })
      .catch(failed);
  if (!installable && appId == null) return null;
  return (
    <>
      {!(site && !installed) && (
        <Button
          variant="outline"
          size="sm"
          data-slot="install-app-button"
          className="ml-0.5 shrink-0"
          disabled={busy}
          onClick={run}
        >
          <AppWindow aria-hidden />
          {t(installed ? "phase5.openApp" : "phase5.installApp")}
        </Button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              data-slot="install-app-more"
              className="ml-0.5 size-7 shrink-0"
              disabled={busy}
              aria-label={t("shell.topBar.more")}
            />
          }
        >
          <MoreHorizontal aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {site && !installed && (
            <DropdownMenuItem data-slot="install-app-item" onClick={run}>
              <AppWindow aria-hidden />
              {t("phase5.installApp")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem data-slot="send-copy-item" onClick={sendCopy}>
            <FileDown aria-hidden />
            <span className="flex flex-col">
              {t("phase5.sendCopy")}
              <span className="text-muted-foreground text-xs">
                {t("phase5.sendCopyHint")}
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
};

export const InstallAppRowButton = (props: Props) =>
  IS_ELECTRON && (PAGE.test(props.target) || LOCAL_URL.test(props.target)) ? (
    <InstallApp {...props} />
  ) : null;
