import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { BrowserApproval, McpBrowserStatus } from "#shared/contracts";

import {
  getBrowserHomepage,
  setBrowserHomepage,
} from "../../lib/browser-homepage";
import { settingsQueryKeys } from "../../lib/settings-query-keys";
import { FocusedPage, FocusedPageBody } from "../layout/focused-page";
import { Button, Input, Switch } from "../ui";
import { Card } from "../ui/card";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

export const BrowserSettingsPanel = (): JSX.Element => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [homepage, setHomepage] = useState(getBrowserHomepage);
  const statusQuery = useQuery({
    queryKey: settingsQueryKeys.browser.status,
    staleTime: 30_000,
    queryFn: async () =>
      (await window.api?.agent?.getMcpBrowserStatus?.()) ?? null,
  });

  useEffect(() => {
    const off = window.api?.agent?.onEvent?.((event) => {
      if (event.type === "browser-status-updated")
        queryClient.setQueryData(
          settingsQueryKeys.browser.status,
          event.status
        );
    });
    return () => off?.();
  }, [queryClient]);

  const updateMutation = useMutation({
    mutationFn: async (next: Partial<McpBrowserStatus>) => {
      if (next.enabled != null)
        await window.api?.agent?.setMcpBrowserEnabled?.(next.enabled);
      if (next.approval != null)
        await window.api?.agent?.setBrowserApproval?.(next.approval);
    },
    onMutate: async (next) => {
      await queryClient.cancelQueries({
        queryKey: settingsQueryKeys.browser.status,
      });
      const previous = queryClient.getQueryData<McpBrowserStatus | null>(
        settingsQueryKeys.browser.status
      );
      queryClient.setQueryData<McpBrowserStatus | null>(
        settingsQueryKeys.browser.status,
        (current) => (current == null ? current : { ...current, ...next })
      );
      return { previous };
    },
    onError: (_error, _next, context) =>
      queryClient.setQueryData(
        settingsQueryKeys.browser.status,
        context?.previous ?? null
      ),
    onSettled: () =>
      void queryClient.invalidateQueries({
        queryKey: settingsQueryKeys.browser.status,
      }),
  });

  const clearMutation = useMutation({
    mutationFn: () => window.api?.agent?.clearBrowserData?.(),
    onSuccess: (result) => {
      if (result?.success) toast.success(t("browserSettings.cleared"));
      else if (result?.error != null) toast.error(result.error);
    },
  });

  const status = statusQuery.data ?? null;
  const busy = updateMutation.isPending || clearMutation.isPending;

  // setMcpBrowserEnabled / setBrowserApproval both emit browser-status-updated
  // which the useEffect above reflects into local state — handlers don't need
  // to set it themselves.
  const handleToggleEnabled = (): void => {
    if (status == null) return;
    updateMutation.mutate({ enabled: !status.enabled });
  };

  const handleApprovalChange = (next: BrowserApproval): void => {
    updateMutation.mutate({ approval: next });
  };

  const handleClearData = (): void => clearMutation.mutate();
  const saveHomepage = (): void => {
    const normalized = setBrowserHomepage(homepage);
    if (normalized == null) {
      toast.error(t("browserSettings.homepageInvalid"));
      return;
    }
    setHomepage(normalized);
    toast.success(t("browserSettings.homepageSaved"));
  };

  const enabled = status?.enabled ?? false;
  // Mirrors the main-process default ('always') so the dialog doesn't flash
  // "Ask each time" before the status query lands.
  const approval: BrowserApproval = status?.approval ?? "always";

  const settings = (
    <div className="space-y-5">
      <Card size="sm" className="bg-muted/40 flex-row items-center gap-4 p-4">
        <div className="bg-primary/10 flex size-9 shrink-0 items-center justify-center rounded-md">
          <Globe className="text-primary size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {t("browserSettings.masterTitle")}
          </div>
          <div className="text-muted-foreground text-xs">
            {t("browserSettings.masterSubtitle")}
          </div>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={() => void handleToggleEnabled()}
          disabled={busy || status == null}
          aria-label={t("browserSettings.masterTitle")}
          data-id="browser-settings-master-toggle"
          onClick={(event) => event.stopPropagation()}
        />
      </Card>

      <section>
        <h3 className="text-muted-foreground mb-2 px-1 text-xs tracking-wide uppercase">
          {t("browserSettings.homepageTitle")}
        </h3>
        <Card
          size="sm"
          className="bg-muted/40 items-stretch gap-2 p-3 @md:flex-row @md:items-center"
        >
          <Input
            type="url"
            value={homepage}
            onChange={(event) => setHomepage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveHomepage();
            }}
            aria-label={t("browserSettings.homepageTitle")}
            data-id="browser-settings-homepage"
          />
          <Button
            variant="secondary"
            onClick={saveHomepage}
            data-id="browser-settings-homepage-save"
            className="self-end"
          >
            {t("browserSettings.homepageSave")}
          </Button>
        </Card>
      </section>

      <section>
        <h3 className="text-muted-foreground mb-2 px-1 text-xs tracking-wide uppercase">
          {t("browserSettings.dataSection")}
        </h3>
        <Card size="sm" className="bg-muted/40 flex-row items-center gap-4 p-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              {t("browserSettings.clearTitle")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("browserSettings.clearSubtitle")}
            </div>
          </div>
          <Button
            variant="secondary"
            onClick={() => void handleClearData()}
            disabled={busy}
            data-id="browser-settings-clear"
          >
            {t("browserSettings.clearAction")}
          </Button>
        </Card>
      </section>

      <section>
        <h3 className="text-muted-foreground mb-2 px-1 text-xs tracking-wide uppercase">
          {t("browserSettings.permissionsSection")}
        </h3>
        <Card size="sm" className="bg-muted/40 flex-row items-center gap-4 p-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">
              {t("browserSettings.approvalTitle")}
            </div>
            <div className="text-muted-foreground text-xs">
              {t("browserSettings.approvalSubtitle")}
            </div>
          </div>
          <Select
            value={approval}
            onValueChange={(next) =>
              void handleApprovalChange(next as BrowserApproval)
            }
            disabled={busy}
          >
            <SelectTrigger data-id="browser-settings-approval">
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
    <FocusedPage data-id="browser-settings-page">
      <FocusedPageBody>{settings}</FocusedPageBody>
    </FocusedPage>
  );
};
