/**
 * "Install as app" on a files card row: a page the `artifact` tool made gets
 * a launcher entry of its own and opens in its own window (desktop only).
 * Decks, PDFs, links, other files and pages written by hand never offer it
 * (the host checks for the tool's versions folder). Once installed, the row
 * offers to open it.
 */
import { isArtifactPage } from "@abacus-ai/contract/share";
import { AppWindow } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { IS_ELECTRON } from "#renderer/lib/platform";
import { showError, showInfo } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

const InstallApp = ({ path }: { path: string }) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const apps = transport.client.system.artifactApps;
  const [installedId, setInstalledId] = useState<string | null>(null);
  const [installable, setInstallable] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void apps
      .status({ path })
      .then((status) => {
        if (!live) return;
        setInstallable(status.installable);
        setInstalledId(status.installedId);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [apps, path]);
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
      .install({ path, title: "" })
      .then(({ id }) => {
        setInstalledId(id);
        showInfo(t("phase5.installedApp"));
      })
      .catch(() => showError(t("phase5.failed")))
      .finally(done);
  };
  // Only a page the `artifact` tool made (or one already installed).
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

export const InstallAppRowButton = ({ path }: { path: string }) =>
  IS_ELECTRON && isArtifactPage(path) ? <InstallApp path={path} /> : null;
