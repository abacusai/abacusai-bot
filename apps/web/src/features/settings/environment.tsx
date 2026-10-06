import { EXEC_BACKENDS } from "@abacus-ai/contract/exec-backends";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  SettingSwitch,
  Segments,
  Choice,
} from "#renderer/components/form-kit/controls";
import {
  AreaPage,
  GroupCard,
  SettingRow,
  StatePill,
} from "#renderer/components/form-kit/page";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { optimistic, useMutation } from "#renderer/data/query-client";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { showError, showInfo } from "#renderer/lib/toast";
import { useAppContext, errorText } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import { Input } from "#renderer/ui/input";
export const EnvironmentPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const query = useQuery(
    transport.orpc.settings.execBackend.get.queryOptions({ input: {} })
  );
  const shell = useQuery(
    transport.orpc.terminal.shell.get.queryOptions({ input: {} })
  );
  const sandbox = useQuery(
    transport.orpc.settings.sandboxSupport.queryOptions({ input: {} })
  );
  const setBackend = useMutation(
    transport.orpc.settings.execBackend.set.mutationOptions({
      ...optimistic(
        transport.orpc.settings.execBackend.get.queryKey({ input: {} }),
        (old, { backend }: { backend: typeof old.selected }) => ({
          ...old,
          selected: backend,
          effective: backend,
        })
      ),
      meta: { errorToast: true },
    })
  );
  const setShell = useMutation(
    transport.orpc.terminal.shell.set.mutationOptions({
      onSuccess: (value) =>
        cache.setQueryData(
          transport.orpc.terminal.shell.get.queryKey({ input: {} }),
          value
        ),
      meta: { errorToast: true },
    })
  );
  return (
    <AreaPage
      title={t("settings.pages.environment")}
      description={t("phase5.settings.environmentDetail")}
    >
      <GroupCard>
        {EXEC_BACKENDS.map((backend) => {
          const status = query.data?.statuses.find((s) => s.id === backend.id);
          return (
            <SettingRow
              id={`backend-${backend.id}`}
              key={backend.id}
              title={t(
                !IS_ELECTRON && backend.id === "local"
                  ? "web.hostLabel"
                  : `execBackends.${backend.labelKey}.label`
              )}
              detail={
                status?.blocker
                  ? t(`phase5.backendBlockers.${status.blocker.kind}`, {
                      command:
                        "command" in status.blocker
                          ? status.blocker.command
                          : "",
                      vars:
                        "vars" in status.blocker
                          ? status.blocker.vars.join(", ")
                          : "",
                    })
                  : undefined
              }
            >
              {query.data?.selected === backend.id ? (
                <StatePill tone="success">{t("phase5.inUse")}</StatePill>
              ) : (
                <Button
                  size="sm"
                  disabled={
                    !status?.ready ||
                    !backend.implemented ||
                    setBackend.isPending
                  }
                  onClick={() => setBackend.mutate({ backend: backend.id })}
                >
                  {t(status?.ready ? "phase5.use" : "phase5.unavailable")}
                </Button>
              )}
            </SettingRow>
          );
        })}
      </GroupCard>
      {query.data && query.data.selected !== query.data.effective && (
        <p role="status">
          {t("phase5.backendFallback", {
            selected: query.data.selected,
            effective: query.data.effective,
          })}
        </p>
      )}
      <GroupCard>
        {shell.data && shell.data.statuses.length > 1 && (
          <SettingRow
            id="terminalShell"
            title={t("phase5.terminalShell")}
            detail={
              shell.data.effective !== shell.data.selected
                ? t("phase5.shellFallback", { shell: shell.data.effective })
                : undefined
            }
          >
            <Choice
              id="terminalShell"
              value={shell.data.selected}
              options={shell.data.statuses.map((x) => ({
                value: x.id,
                label:
                  t(`terminalShells.${x.id}.label`) +
                  (x.available ? "" : ` · ${t("phase5.notFoundMachine")}`),
              }))}
              onChange={(selected) =>
                setShell.mutate({
                  shell:
                    selected as import("@abacus-ai/contract/terminal-shells").TerminalShellId,
                })
              }
            />
          </SettingRow>
        )}
        <SettingRow
          id="sandbox"
          title={t("phase5.sandbox")}
          detail={sandbox.data?.reason ?? undefined}
        >
          <StatePill tone={sandbox.data?.available ? "success" : "warning"}>
            {t(
              sandbox.data?.available
                ? "phase5.available"
                : "phase5.unavailable"
            )}
          </StatePill>
        </SettingRow>
      </GroupCard>
    </AreaPage>
  );
};
export const normalizeHomepage = (value: string): string | null => {
  const raw = value.trim();
  if (!raw) return null;
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("invalid-url");
  return url.href;
};
export const BrowserPage = () => (IS_ELECTRON ? <ElectronBrowserPage /> : null);
const ElectronBrowserPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const query = useQuery(
    transport.orpc.browser.status.queryOptions({ input: {} })
  );
  const [token, setToken] = useState("");
  const [home, setHome] = useState(prefs.browserHomepage ?? "");
  const status = query.data;
  // Each write answers with the new status.
  const writesStatus = {
    onSuccess: (value: NonNullable<typeof status>) =>
      cache.setQueryData(
        transport.orpc.browser.status.queryKey({ input: {} }),
        value
      ),
    meta: { errorToast: true },
  } as const;
  const { browser } = transport.orpc;
  const setEnabled = useMutation(
    browser.setEnabled.mutationOptions(writesStatus)
  );
  const setEngine = useMutation(
    browser.setEngine.mutationOptions(writesStatus)
  );
  const connectChrome = useMutation(
    browser.chrome.connect.mutationOptions(writesStatus)
  );
  const disconnectChrome = useMutation(
    browser.chrome.disconnect.mutationOptions(writesStatus)
  );
  const setExtensionToken = useMutation(
    browser.chrome.setExtensionToken.mutationOptions(writesStatus)
  );
  const setApproval = useMutation(
    browser.permissions.setApproval.mutationOptions(writesStatus)
  );
  const clearData = useMutation(
    browser.clearData.mutationOptions({
      onSuccess: () => showInfo(t("phase5.cleared")),
      meta: { errorToast: true },
    })
  );
  const chromeBusy = connectChrome.isPending || disconnectChrome.isPending;
  return (
    <AreaPage title={t("settings.pages.browser")}>
      <GroupCard>
        <SettingRow
          id="browserEnabled"
          title={t("phase5.settings.browserEnabled")}
        >
          <SettingSwitch
            id="browserEnabled"
            checked={status?.enabled ?? false}
            onCheckedChange={(enabled) => setEnabled.mutate({ enabled })}
          />
        </SettingRow>
        <SettingRow
          id="browserEngine"
          title={t("phase5.settings.browserEngine")}
        >
          <Segments
            label={t("phase5.settings.browserEngine")}
            value={status?.engine ?? "builtin"}
            values={[
              { value: "builtin", label: t("phase5.builtIn") },
              { value: "chrome", label: "Chrome" },
            ]}
            onChange={(engine) =>
              setEngine.mutate({ engine: engine as "builtin" | "chrome" })
            }
          />
        </SettingRow>
        {status?.engine === "chrome" && (
          <>
            <SettingRow
              id="chromeExtension"
              title={t("phase5.chromeExtension")}
              detail={status.chrome.error ?? undefined}
            >
              <StatePill>
                {t(
                  status.chrome.connected
                    ? "phase5.connected"
                    : "phase5.notConnected"
                )}
              </StatePill>
              <Button
                size="sm"
                disabled={chromeBusy}
                onClick={() =>
                  (status.chrome.connected
                    ? disconnectChrome
                    : connectChrome
                  ).mutate({})
                }
              >
                {t(
                  status.chrome.connected
                    ? "phase5.disconnect"
                    : "phase5.connect"
                )}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void transport.client.system.openExternal({
                    url: status.chrome.installUrl,
                  })
                }
              >
                {t("phase5.installExtension")}
              </Button>
            </SettingRow>
            <div className="flex gap-2 p-3">
              <Input
                aria-label={t("phase5.extensionToken")}
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <Button
                disabled={setExtensionToken.isPending}
                onClick={() => {
                  setExtensionToken.mutate({ token: token.trim() });
                  setToken("");
                }}
              >
                {t("phase5.save")}
              </Button>
            </div>
          </>
        )}
        <SettingRow
          id="browserHomepage"
          title={t("phase5.settings.browserHomepage")}
        >
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              try {
                void update({ browserHomepage: normalizeHomepage(home) })
                  .then(() => showInfo(t("phase5.saved")))
                  .catch((e) => showError(errorText(e)));
              } catch {
                showError(t("phase5.invalidUrl"));
              }
            }}
          >
            <Input
              aria-labelledby="browserHomepage-label"
              value={home}
              onChange={(e) => setHome(e.target.value)}
            />
            <Button type="submit" size="sm">
              {t("phase5.save")}
            </Button>
          </form>
        </SettingRow>
        <SettingRow
          id="browserApproval"
          title={t("phase5.settings.browserApproval")}
        >
          <Segments
            label={t("phase5.settings.browserApproval")}
            value={status?.approval ?? "ask"}
            values={["ask", "always"].map((x) => ({
              value: x,
              label: t(`phase5.${x}`),
            }))}
            onChange={(approval) =>
              setApproval.mutate({ approval: approval as "ask" | "always" })
            }
          />
        </SettingRow>
        <SettingRow id="browserData" title={t("phase5.settings.browserData")}>
          <Button
            size="sm"
            variant="secondary"
            disabled={clearData.isPending}
            onClick={() => clearData.mutate({})}
          >
            {t("phase5.clearAll")}
          </Button>
        </SettingRow>
      </GroupCard>
    </AreaPage>
  );
};
export const DevicesPage = () => (IS_ELECTRON ? <ElectronDevicesPage /> : null);
const ElectronDevicesPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const query = useQuery(
    transport.orpc.devices.status.queryOptions({ input: {} })
  );
  const statusKey = transport.orpc.devices.status.queryKey({ input: {} });
  // Each write answers with the new status.
  const writesStatus = {
    onSuccess: (value: NonNullable<typeof query.data>) =>
      cache.setQueryData(statusKey, value),
    meta: { errorToast: true },
  } as const;
  const setEnabled = useMutation(
    transport.orpc.devices.setEnabled.mutationOptions(writesStatus)
  );
  const setApproval = useMutation(
    transport.orpc.devices.setApproval.mutationOptions(writesStatus)
  );
  const installMaestro = useMutation(
    transport.orpc.devices.installMaestro.mutationOptions({
      meta: { invalidates: [statusKey], errorToast: true },
    })
  );
  return (
    <AreaPage title={t("settings.pages.devices")}>
      <GroupCard>
        <SettingRow
          id="deviceEnabled"
          title={t("phase5.settings.deviceEnabled")}
        >
          <SettingSwitch
            id="deviceEnabled"
            checked={query.data?.enabled ?? false}
            onCheckedChange={(enabled) => setEnabled.mutate({ enabled })}
          />
        </SettingRow>
        {(["ios", "android", "maestro"] as const).map((key) => (
          <SettingRow
            key={key}
            id={`device-${key}`}
            title={t(`phase5.deviceTools.${key}`)}
          >
            <StatePill>
              {t(query.data?.[key] ? "phase5.detected" : "phase5.notDetected")}
            </StatePill>
            {key === "maestro" && !query.data?.maestro && (
              <Button
                size="sm"
                disabled={installMaestro.isPending}
                onClick={() => installMaestro.mutate({})}
              >
                {t("phase5.install")}
              </Button>
            )}
          </SettingRow>
        ))}
        <SettingRow
          id="deviceApproval"
          title={t("phase5.settings.deviceApproval")}
        >
          <Segments
            label={t("phase5.settings.deviceApproval")}
            value={query.data?.approval ?? "ask"}
            values={["ask", "always"].map((x) => ({
              value: x,
              label: t(`phase5.${x}`),
            }))}
            onChange={(approval) =>
              setApproval.mutate({ approval: approval as "ask" | "always" })
            }
          />
        </SettingRow>
      </GroupCard>
    </AreaPage>
  );
};
