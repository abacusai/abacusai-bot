/**
 * "Save" and "Save all" on the bot's files: a copy where the user picks.
 * One path for every place files are shown (`#platform/preview-files`):
 * the desktop's own dialogs through main, the browser's downloads on the
 * web. The outcome is said once here, so every surface reads the same.
 */
import type { SaveCopyResult } from "@abacus-ai/contract/contract/system";
import { Download } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { revealSaved, saveFiles } from "#platform/preview-files";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { showError, showInfo } from "#renderer/lib/toast";
import { Button } from "#renderer/ui/button";

import { containmentRootFor } from "./paths";

type T = ReturnType<typeof useTranslation>["t"];

/** Says where the copy went, with Show in folder; quiet when cancelled. */
export const announceSaved = (result: SaveCopyResult, t: T): void => {
  if (result.destination == null) {
    if (result.saved === 0 && result.skipped > 0)
      showError(t("deliverables.downloadMissing"));
    return;
  }
  const destination = result.destination;
  showInfo(
    t(
      result.skipped > 0
        ? "deliverables.downloadedSome"
        : "deliverables.downloaded"
    ),
    {
      description: destination,
      action: {
        label: t("bots.chat.deliverables.showInFolder"),
        onClick: () => void revealSaved(destination).catch(() => undefined),
      },
    }
  );
};

/**
 * Saves `paths` and says how it went. `workspaceRoot` places a guest
 * `/workspace/…` path, as the readers' containment root does.
 */
export const useSaveFiles = (workspaceRoot: string | null = null) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const save = (paths: readonly string[]): void => {
    if (paths.length === 0 || busy) return;
    setBusy(true);
    void saveFiles(
      paths.map((filePath) => ({
        filePath,
        hostRoot: containmentRootFor(filePath, workspaceRoot) || filePath,
      }))
    )
      .then((result) => announceSaved(result, t))
      .catch(() => showError(t("deliverables.downloadFailed")))
      .finally(() => setBusy(false));
  };
  return { save, busy };
};

/** Download on one row of a files card: a copy where the user picks. */
export const SaveRowButton = ({
  path,
  workspaceRoot = null,
}: {
  path: string;
  workspaceRoot?: string | null;
}) => {
  const { t } = useTranslation();
  const { save, busy } = useSaveFiles(workspaceRoot);
  const label = t("deliverables.download");
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      data-slot="deliverable-save"
      className="text-muted-foreground shrink-0"
      disabled={busy}
      onClick={() => save([path])}
    >
      <Download />
    </Button>
  );
};

/**
 * Download all: every file into one folder the user picks. Desktop only: a
 * browser would ask about each download, and cannot take a folder.
 */
export const SaveAllButton = ({
  paths,
  workspaceRoot = null,
  size = "xs",
}: {
  paths: readonly string[];
  workspaceRoot?: string | null;
  /** `sm` beside a page's toolbar controls. */
  size?: "xs" | "sm";
}) => {
  const { t } = useTranslation();
  const { save, busy } = useSaveFiles(workspaceRoot);
  if (!IS_ELECTRON || paths.length < 2) return null;
  return (
    <Button
      variant={size === "sm" ? "outline" : "ghost"}
      size={size}
      data-slot="deliverables-save-all"
      className="text-muted-foreground"
      disabled={busy}
      onClick={() => save(paths)}
    >
      <Download aria-hidden />
      {t("deliverables.downloadAll")}
    </Button>
  );
};
