import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type {
  BrowserApproval,
  BrowserEngine,
  McpBrowserStatus,
} from "#shared/contracts";

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

  const [token, setToken] = useState("");
  const chromeMutation = useMutation({
    mutationFn: async (
      action:
        | { kind: "engine"; engine: BrowserEngine }
        | { kind: "connect" }
        | { kind: "disconnect" }
        | { kind: "token"; token: string }
    ): Promise<McpBrowserStatus | null> => {
      const agent = window.api?.agent;
      if (agent == null) return null;
      switch (action.kind) {
        case "engine":
          return agent.setBrowserEngine(action.engine);
        case "connect":
          return agent.connectChromeBrowser();
        case "disconnect":
          return agent.disconnectChromeBrowser();
        case "token":
          return agent.setChromeExtensionToken(action.token);
      }
    },
    onSuccess: (next) => {
      if (next != null)
        queryClient.setQueryData(settingsQueryKeys.browser.status, next);
    },
  });

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
  const engine: BrowserEngine = status?.engine ?? "builtin";
  const chrome = status?.chrome ?? null;

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
          {t("browserSettings.engineSection")}
        </h3>
        <Card size="sm" className="bg-muted/40 flex flex-col gap-3 p-4">
          <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                {t("browserSettings.engineTitle")}
              </div>
              <div className="text-muted-foreground text-xs">
                {t("browserSettings.engineSubtitle")}
              </div>
            </div>
            <Select
              value={engine}
              onValueChange={(value) => {
                if (value === "builtin" || value === "chrome")
                  chromeMutation.mutate({ kind: "engine", engine: value });
              }}
              disabled={busy || status == null}
            >
              <SelectTrigger data-id="browser-settings-engine">
                <SelectValue>
                  {t(`browserSettings.engine.${engine}`)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="builtin">
                    {t("browserSettings.engine.builtin")}
                  </SelectItem>
                  <SelectItem value="chrome">
                    {t("browserSettings.engine.chrome")}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          {engine === "chrome" && chrome != null && (
            <div
              className="border-border flex flex-col gap-2 border-t pt-3"
              data-id="browser-settings-chrome"
            >
              <div className="text-muted-foreground text-xs">
                {chrome.browser == null
                  ? t("browserSettings.chrome.notFound")
                  : !chrome.extensionInstalled
                    ? t("browserSettings.chrome.extensionMissing", {
                        browser: chrome.browser,
                      })
                    : chrome.connected
                      ? t("browserSettings.chrome.connected", {
                          browser: chrome.browser,
                          count: chrome.tabs,
                        })
                      : chrome.connecting
                        ? t("browserSettings.chrome.connecting")
                        : t("browserSettings.chrome.ready", {
                            browser: chrome.browser,
                          })}
              </div>
              {chrome.error != null && (
                <div
                  className="text-destructive text-xs"
                  data-id="browser-settings-chrome-error"
                >
                  {chrome.error}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {!chrome.extensionInstalled && (
                  <Button
                    size="sm"
                    data-id="browser-settings-chrome-install"
                    onClick={() =>
                      void window.api?.openExternal?.(chrome.installUrl)
                    }
                  >
                    {t("browserSettings.chrome.install")}
                  </Button>
                )}
                {chrome.extensionInstalled && !chrome.connected && (
                  <Button
                    size="sm"
                    data-id="browser-settings-chrome-connect"
                    disabled={chrome.connecting || chromeMutation.isPending}
                    onClick={() => chromeMutation.mutate({ kind: "connect" })}
                  >
                    {t("browserSettings.chrome.connect")}
                  </Button>
                )}
                {chrome.connected && (
                  <Button
                    size="sm"
                    variant="secondary"
                    data-id="browser-settings-chrome-disconnect"
                    onClick={() =>
                      chromeMutation.mutate({ kind: "disconnect" })
                    }
                  >
                    {t("browserSettings.chrome.disconnect")}
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  placeholder={t("browserSettings.chrome.tokenPlaceholder")}
                  aria-label={t("browserSettings.chrome.tokenTitle")}
                  data-id="browser-settings-chrome-token"
                  className="flex-1"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  data-id="browser-settings-chrome-token-save"
                  disabled={token.trim().length === 0}
                  onClick={() => {
                    chromeMutation.mutate({ kind: "token", token });
                    setToken("");
                    toast.success(t("browserSettings.chrome.tokenSaved"));
                  }}
                >
                  {t("browserSettings.chrome.tokenSave")}
                </Button>
              </div>
              <div className="text-muted-foreground text-[0.625rem]">
                {t("browserSettings.chrome.tokenHint")}
              </div>
            </div>
          )}
        </Card>
      </section>

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
