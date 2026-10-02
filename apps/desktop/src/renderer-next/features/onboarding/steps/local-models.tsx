import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { followNotices } from "#next/data/queries/live";
import type { Transport } from "#next/data/transport";
import { Button } from "#next/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "#next/ui/dialog";
export const OnboardingLocalModels = ({
  transport,
  saved,
}: {
  transport: Transport;
  saved(): Promise<unknown>;
}) => {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const state = useQuery({
    ...transport.orpc.localModels.state.queryOptions({ input: {} }),
    enabled: open,
  });
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void followNotices(
      transport,
      ({ signal }) => transport.client.localModels.progress({}, { signal }),
      () => {
        void state.refetch();
      },
      abort.signal
    );
    return () => abort.abort();
  }, [open, transport, state]);
  const install = async (modelId: string) => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const result = await transport.client.localModels.install({ modelId });
      if (!result.ok) setError(true);
      else {
        await saved();
        await state.refetch();
      }
    } catch {
      setError(true);
    }
    setBusy(false);
  };
  const gb = (bytes: number) =>
    new Intl.NumberFormat(i18n.language, {
      maximumFractionDigits: 1,
      style: "unit",
      unit: "gigabyte",
    }).format(bytes / 1024 ** 3);
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        {t("localModels.useLocal")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("localModels.title")}</DialogTitle>
            <DialogDescription>
              {t("localModels.description")}
            </DialogDescription>
          </DialogHeader>
          {state.data?.runtimeAvailable === false ? (
            <p>{t("localModels.unavailable")}</p>
          ) : (
            state.data?.catalog.map((model) => (
              <div
                key={model.id}
                className="flex items-center justify-between gap-3 rounded-xl border p-3"
              >
                <span>{model.label}</span>
                <Button disabled={busy} onClick={() => void install(model.id)}>
                  {state.data?.installedIds.includes(model.id)
                    ? t("localModels.use", { model: model.label })
                    : t("localModels.download", { size: gb(model.sizeBytes) })}
                </Button>
              </div>
            ))
          )}
          {state.data?.download && (
            <>
              <p role="status">
                {t("localModels.downloading", {
                  received: gb(state.data.download.receivedBytes),
                  total: gb(state.data.download.totalBytes),
                  percent: Math.round(
                    (state.data.download.receivedBytes /
                      Math.max(1, state.data.download.totalBytes)) *
                      100
                  ),
                })}
              </p>
              <Button
                variant="ghost"
                onClick={() =>
                  void transport.client.localModels.cancelInstall({})
                }
              >
                {t("localModels.stopDownload")}
              </Button>
            </>
          )}
          {error && <p role="alert">{t("onboarding.frame.failed")}</p>}
        </DialogContent>
      </Dialog>
    </>
  );
};
