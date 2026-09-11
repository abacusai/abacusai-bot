import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TabletSmartphone } from "lucide-react";
import { useEffect, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { BrowserApproval, DeviceStatus } from "#shared/contracts";

import { settingsQueryKeys } from "../../lib/settings-query-keys";
import {
  FocusedPage,
  FocusedPageBody,
  FocusedPageLead,
} from "../layout/focused-page";
import { Button, Switch } from "../ui";
import { Card } from "../ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

/**
 * Settings for the built-in device MCP server (iOS simulator / Android
 * emulator tools in Code mode). Mirrors BrowserSettingsDialog.
 */
export const DeviceSettingsPanel = (): JSX.Element => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: settingsQueryKeys.devices.status,
    queryFn: async () => (await window.api?.agent?.getDeviceStatus?.()) ?? null,
  });

  useEffect(() => {
    const off = window.api?.agent?.onEvent?.((event) => {
      if (event.type === "device-status-updated")
        queryClient.setQueryData(
          settingsQueryKeys.devices.status,
          event.status
        );
    });
    return () => off?.();
  }, [queryClient]);

  const updateMutation = useMutation({
    mutationFn: async (next: Partial<DeviceStatus>) => {
      if (next.enabled != null)
        await window.api?.agent?.setDevicesEnabled?.(next.enabled);
      if (next.approval != null)
        await window.api?.agent?.setDevicesApproval?.(next.approval);
    },
    onMutate: async (next) => {
      await queryClient.cancelQueries({
        queryKey: settingsQueryKeys.devices.status,
      });
      const previous = queryClient.getQueryData<DeviceStatus | null>(
        settingsQueryKeys.devices.status
      );
      queryClient.setQueryData<DeviceStatus | null>(
        settingsQueryKeys.devices.status,
        (current) => (current == null ? current : { ...current, ...next })
      );
      return { previous };
    },
    onError: (_error, _next, context) =>
      queryClient.setQueryData(
        settingsQueryKeys.devices.status,
        context?.previous ?? null
      ),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: settingsQueryKeys.devices.status,
      }),
  });

  const status = statusQuery.data ?? null;
  const busy = updateMutation.isPending;

  const handleToggleEnabled = (): void => {
    if (status == null) return;
    updateMutation.mutate({ enabled: !status.enabled });
  };

  const handleApprovalChange = (next: BrowserApproval): void => {
    updateMutation.mutate({ approval: next });
  };

  const enabled = status?.enabled ?? false;
  const approval: BrowserApproval = status?.approval ?? "ask";

  const settings = (
    <div className="space-y-5">
      <Card size="sm" className="bg-muted/40 flex-row items-center gap-4 p-4">
        <div className="bg-primary/10 flex size-9 shrink-0 items-center justify-center rounded-md">
          <TabletSmartphone className="text-primary size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {t("deviceSettings.masterTitle")}
          </div>
          <div className="text-muted-foreground text-xs">
            {t("deviceSettings.masterSubtitle")}
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={() => void handleToggleEnabled()}
          disabled={busy || status == null}
          aria-label={t("deviceSettings.masterTitle")}
          data-id="device-settings-master-toggle"
          onClick={(event) => event.stopPropagation()}
        />
      </Card>
      <Card
        size="sm"
        className="bg-muted/40 gap-1.5 p-4"
        data-id="device-settings-toolchains"
      >
        <h3 className="text-muted-foreground mb-2 text-xs tracking-wide uppercase">
          {t("deviceSettings.toolchainSection")}
        </h3>
        <ToolchainRow
          id="ios"
          label={t("deviceSettings.toolchainIos")}
          present={status?.ios === true}
          setupUrl={XCODE_URL}
          t={t}
        />
        <ToolchainRow
          id="android"
          label={t("deviceSettings.toolchainAndroid")}
          present={status?.android === true}
          setupUrl={ANDROID_STUDIO_URL}
          t={t}
        />
        <ToolchainRow
          id="maestro"
          label={t("deviceSettings.toolchainMaestro")}
          present={status?.maestro === true}
          setupUrl={MAESTRO_URL}
          t={t}
        />
        {status?.maestro !== true && (
          <div className="text-muted-foreground pt-1 text-xs">
            {t("deviceSettings.maestroHint")}
          </div>
        )}
      </Card>
      <section>
        <h3 className="text-muted-foreground mb-2 px-1 text-xs tracking-wide uppercase">
          {t("browserSettings.permissionsSection")}
        </h3>
        <Card size="sm" className="bg-muted/40 flex-row items-center gap-4 p-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              {t("deviceSettings.approvalTitle")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("deviceSettings.approvalSubtitle")}
            </div>
          </div>
          <Select
            value={approval}
            onValueChange={(next) =>
              void handleApprovalChange(next as BrowserApproval)
            }
            disabled={busy}
          >
            <SelectTrigger data-id="device-settings-approval">
              <SelectValue>
                {approval === "ask"
                  ? t("browserSettings.approval.ask")
                  : t("browserSettings.approval.always")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent align="end">
              <SelectGroup>
                <SelectItem value="ask">
                  {t("browserSettings.approval.ask")}
                </SelectItem>
                <SelectItem value="always">
                  {t("browserSettings.approval.always")}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Card>
      </section>
    </div>
  );

  return (
    <FocusedPage data-id="device-settings-page">
      <FocusedPageBody>
        <FocusedPageLead description={t("deviceSettings.subtitle")} />
        {settings}
      </FocusedPageBody>
    </FocusedPage>
  );
};

// Setup destinations for missing toolchains (also used by the device panel's
// empty-state setup guide).
const XCODE_URL = "https://apps.apple.com/app/xcode/id497799835";
const ANDROID_STUDIO_URL = "https://developer.android.com/studio";
const MAESTRO_URL =
  "https://docs.maestro.dev/getting-started/installing-maestro";

const ToolchainRow = ({
  id,
  label,
  present,
  setupUrl,
  t,
}: {
  id: string;
  label: string;
  present: boolean;
  setupUrl: string;
  t: (key: string) => string;
}): JSX.Element => (
  <div className="flex items-center justify-between gap-2 text-sm">
    <span>{label}</span>
    {present ? (
      <span className="text-primary text-xs">
        {t("deviceSettings.detected")}
      </span>
    ) : (
      <span className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs">
          {t("deviceSettings.notDetected")}
        </span>
        <Button
          variant="link"
          size="sm"
          onClick={() => void window.api?.openExternal?.(setupUrl)}
          data-id={`device-settings-setup-${id}`}
        >
          {t("deviceSetup.download")}
        </Button>
      </span>
    )}
  </div>
);
