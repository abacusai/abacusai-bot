import { Check, Cpu, Download } from "lucide-react";
import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import {
  localModelReference,
  localModelSpec,
  type LocalModelSpec,
} from "#shared/local-models";

import { useLocalModels } from "../../hooks/use-local-models";
import { useLocalModelDialogStore } from "../../stores/local-model-dialog-store";
import { Button, Spinner } from "../ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

const GB = 1024 ** 3;

export const gigabytes = (bytes: number): string =>
  `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;

/**
 * "Use a local model", one click: the model this machine is recommended, its
 * size, a download with progress, and the model picked once it is ready. No
 * account, no key, no quota — the way on when every free source is used up.
 */
export const LocalModelDialog = (): JSX.Element | null => {
  const { t } = useTranslation();
  const open = useLocalModelDialogStore((store) => store.open);
  const onReady = useLocalModelDialogStore((store) => store.onReady);
  const hide = useLocalModelDialogStore((store) => store.hide);
  const { state, install, cancel } = useLocalModels();
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const recommended: LocalModelSpec | undefined =
    state != null ? localModelSpec(state.recommendedId) : undefined;
  const download = state?.download ?? null;
  const installed =
    recommended != null &&
    state?.installedIds.includes(recommended.id) === true;
  const tight =
    recommended != null &&
    state != null &&
    state.totalMemoryBytes < recommended.minMemoryBytes;

  const adoptModel = (spec: LocalModelSpec): void => {
    onReady?.(localModelReference(spec.id));
    hide();
  };

  const start = (): void => {
    if (recommended == null) return;
    setError(null);
    void install(recommended.id).then((outcome) => {
      if (outcome.ok) adoptModel(recommended);
      else if (outcome.error !== "cancelled") setError(outcome.error);
    });
  };

  const percent =
    download != null && download.totalBytes > 0
      ? Math.floor((download.receivedBytes / download.totalBytes) * 100)
      : 0;

  return (
    <Dialog open onOpenChange={(next) => !next && hide()}>
      <DialogContent data-id="local-model-dialog" className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cpu className="size-4" />
            {t("localModels.title")}
          </DialogTitle>
          <DialogDescription>{t("localModels.description")}</DialogDescription>
        </DialogHeader>

        {state == null ? (
          <Spinner />
        ) : !state.runtimeAvailable ? (
          <div className="text-muted-foreground text-xs">
            {t("localModels.unavailable")}
          </div>
        ) : recommended == null ? null : (
          <div
            data-id="local-model-recommended"
            className="border-border bg-muted/20 flex flex-col gap-1.5 rounded-xl border p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{recommended.label}</span>
              <span className="text-muted-foreground text-xs">
                {gigabytes(recommended.sizeBytes)}
              </span>
            </div>
            <div className="text-muted-foreground text-xs">
              {t("localModels.machine", {
                memory: gigabytes(state.totalMemoryBytes),
              })}
              {tight ? ` ${t("localModels.tight")}` : ""}
            </div>
            {download != null && (
              <div
                className="flex flex-col gap-1"
                data-id="local-model-progress"
              >
                <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
                  <div
                    className="bg-primary h-full rounded-full transition-[width]"
                    style={{ width: `${percent}%` }}
                  />
                </div>
                <div className="text-muted-foreground text-[0.625rem]">
                  {download.phase === "verifying"
                    ? t("localModels.verifying")
                    : t("localModels.downloading", {
                        received: gigabytes(download.receivedBytes),
                        total: gigabytes(download.totalBytes),
                        percent,
                      })}
                </div>
              </div>
            )}
            {error != null && (
              <div
                className="text-destructive text-xs"
                data-id="local-model-error"
              >
                {error}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="secondary" onClick={hide}>
            {t("common.cancel")}
          </Button>
          {recommended != null &&
            state?.runtimeAvailable === true &&
            (download != null ? (
              <Button
                variant="secondary"
                data-id="local-model-cancel"
                onClick={() => void cancel()}
              >
                {t("localModels.stopDownload")}
              </Button>
            ) : installed ? (
              <Button
                data-id="local-model-use"
                onClick={() => adoptModel(recommended)}
              >
                <Check />
                {t("localModels.use", { model: recommended.label })}
              </Button>
            ) : (
              <Button data-id="local-model-download" onClick={start}>
                <Download />
                {t("localModels.download", {
                  size: gigabytes(recommended.sizeBytes),
                })}
              </Button>
            ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
