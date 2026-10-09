/**
 * The local-model row of the models slide (canvas OnboardModels, spec 06
 * F12): "Run a model on this computer · {model}, {size}, no account" with
 * Download → a 4 px progress bar and percentage (Stop) → Installed. Reads
 * `localModels.state` and follows `localModels.progress`; absent when the
 * build cannot run models locally. Electron only (the platform alias).
 */
import { useQuery } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { followNotices } from "#renderer/data/queries/notices";
import type { Transport } from "#renderer/data/transport";

import { ConnectedMark, StepButton, StepLink } from "./kit";

export const OnboardingLocalModels = ({
  transport,
  saved,
}: {
  transport: Transport;
  saved(): Promise<unknown>;
}) => {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const state = useQuery({
    ...transport.orpc.localModels.state.queryOptions({ input: {} }),
    retry: false,
  });
  const refetch = state.refetch;
  useEffect(() => {
    const abort = new AbortController();
    void followNotices(
      transport,
      ({ signal }) => transport.client.localModels.progress({}, { signal }),
      () => {
        void refetch();
      },
      abort.signal
    );
    return () => abort.abort();
  }, [transport, refetch]);
  const data = state.data;
  if (state.isError || !data || !data.runtimeAvailable) return null;
  const model =
    data.catalog.find((spec) => spec.id === data.recommendedId) ??
    data.catalog[0];
  if (!model) return null;
  const gb = (bytes: number) =>
    new Intl.NumberFormat(i18n.language, {
      maximumFractionDigits: 1,
      style: "unit",
      unit: "gigabyte",
    }).format(bytes / 1024 ** 3);
  const install = async () => {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      const result = await transport.client.localModels.install({
        modelId: model.id,
      });
      if (!result.ok) setError(true);
      else {
        await saved();
        await refetch();
      }
    } catch {
      setError(true);
    }
    setBusy(false);
  };
  const download =
    data.download?.modelId === model.id &&
    ["downloading", "verifying"].includes(data.download.phase)
      ? data.download
      : null;
  const installed = data.installedIds.includes(model.id);
  const percent = download
    ? Math.round(
        (download.receivedBytes / Math.max(1, download.totalBytes)) * 100
      )
    : 0;
  return (
    <div
      className="onboarding-row"
      data-slot="local-model-row"
      data-connected={installed}
    >
      <span
        aria-hidden="true"
        className="bg-background/60 flex size-12 shrink-0 items-center justify-center rounded-[10px]"
      >
        <Laptop size={24} strokeWidth={1.75} />
      </span>
      <span className="onboarding-row-title min-w-0 flex-1 text-sm">
        {t("onboarding.pages.models.local")}{" "}
        <span className="onboarding-accent">
          {t("onboarding.pages.models.localAccent")}
        </span>{" "}
        <span className="text-muted-foreground mt-1 block text-[13px] font-normal">
          {t("onboarding.pages.models.localDetails", {
            model: model.label,
            size: gb(model.sizeBytes),
          })}
        </span>
        {error && (
          <span role="alert" className="onboarding-quiet block">
            {t("onboarding.frame.failed")}
          </span>
        )}
      </span>
      {installed ? (
        <ConnectedMark>{t("localModels.installed")}</ConnectedMark>
      ) : download ? (
        <span className="flex w-[140px] flex-col gap-1" role="status">
          <span className="text-muted-foreground flex justify-between text-xs">
            <span>
              {t(
                download.phase === "verifying"
                  ? "localModels.verifying"
                  : "onboarding.pages.models.downloading"
              )}
            </span>
            <span>{percent}%</span>
          </span>
          <span
            className="bg-border block h-1 overflow-hidden rounded-sm"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span
              className="bg-primary block h-1 rounded-sm transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </span>
          <StepLink
            className="h-6 self-end px-1 text-xs"
            onClick={() => void transport.client.localModels.cancelInstall({})}
          >
            {t("localModels.stopDownload")}
          </StepLink>
        </span>
      ) : (
        <StepButton
          variant="small"
          disabled={busy}
          onClick={() => void install()}
        >
          {t("onboarding.pages.models.download")}
        </StepButton>
      )}
    </div>
  );
};
