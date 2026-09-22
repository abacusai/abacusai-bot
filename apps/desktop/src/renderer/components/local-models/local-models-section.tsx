import { Check, Download, Trash2 } from "lucide-react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";

import { useLocalModels } from "../../hooks/use-local-models";
import { ProviderMark } from "../chat/provider-mark";
import {
  Button,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../ui";
import { gigabytes } from "./local-model-dialog";

/**
 * The models settings page's "On this machine" section: every catalog model,
 * which one this machine is recommended, what is installed, and the download
 * or removal of each. Absent on a build without the runtime.
 */
export const LocalModelsSection = (): JSX.Element | null => {
  const { t } = useTranslation();
  const { state, install, cancel, remove } = useLocalModels();

  if (state == null || !state.runtimeAvailable) return null;

  return (
    <div data-id="local-models-section">
      <div className="text-muted-foreground mt-4 mb-2 text-[0.625rem] font-medium tracking-wide uppercase">
        {t("localModels.onThisMachine")}
      </div>
      <div className="text-muted-foreground mb-2 text-xs">
        {t("localModels.sectionHint")}
      </div>
      <ItemGroup className="grid grid-cols-1 gap-2 @2xl:grid-cols-2">
        {state.catalog.map((spec) => {
          const installed = state.installedIds.includes(spec.id);
          const downloading = state.download?.modelId === spec.id;
          const percent =
            downloading &&
            state.download != null &&
            state.download.totalBytes > 0
              ? Math.floor(
                  (state.download.receivedBytes / state.download.totalBytes) *
                    100
                )
              : 0;
          return (
            <Item
              key={spec.id}
              variant="outline"
              className="items-start"
              data-id={`local-model-${spec.id}`}
            >
              <ItemMedia variant="icon">
                <ProviderMark provider="local" className="size-5" />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {spec.label}
                  {spec.id === state.recommendedId && (
                    <span className="text-primary ms-2 text-[0.625rem] font-medium uppercase">
                      {t("localModels.recommended")}
                    </span>
                  )}
                </ItemTitle>
                <ItemDescription>
                  {downloading
                    ? t("localModels.downloading", {
                        received: gigabytes(state.download?.receivedBytes ?? 0),
                        total: gigabytes(spec.sizeBytes),
                        percent,
                      })
                    : gigabytes(spec.sizeBytes)}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {installed ? (
                  <>
                    <span className="text-primary flex items-center gap-1 text-xs">
                      <Check className="size-3.5" />
                      {t("localModels.installed")}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      data-id={`local-model-remove-${spec.id}`}
                      aria-label={t("localModels.remove")}
                      title={t("localModels.remove")}
                      onClick={() => void remove(spec.id)}
                    >
                      <Trash2 size={11} />
                    </Button>
                  </>
                ) : downloading ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    data-id={`local-model-cancel-${spec.id}`}
                    onClick={() => void cancel()}
                  >
                    {t("localModels.stopDownload")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    data-id={`local-model-download-${spec.id}`}
                    disabled={state.download != null}
                    onClick={() => void install(spec.id)}
                  >
                    <Download />
                    {t("localModels.download", {
                      size: gigabytes(spec.sizeBytes),
                    })}
                  </Button>
                )}
              </ItemActions>
            </Item>
          );
        })}
      </ItemGroup>
    </div>
  );
};
