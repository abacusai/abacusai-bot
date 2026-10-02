import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  SettingSwitch,
  Segments,
  Choice,
} from "#next/components/form-kit/controls";
import {
  AreaPage,
  GroupCard,
  SettingRow,
  StatePill,
} from "#next/components/form-kit/page";
import { usePrefs, useUpdatePrefs } from "#next/data/db/prefs";
import { showError, showInfo } from "#next/lib/toast";
import { useAppContext, errorText } from "#next/lib/use-app-context";
import { Button } from "#next/ui/button";
import { Input } from "#next/ui/input";
import { EXEC_BACKENDS } from "#shared/exec-backends";
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
              title={t(`execBackends.${backend.labelKey}.label`)}
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
                <StatePill>{t("phase5.inUse")}</StatePill>
              ) : (
                <Button
                  size="sm"
                  disabled={!status?.ready || !backend.implemented}
                  onClick={() => {
                    const key =
                      transport.orpc.settings.execBackend.get.queryKey({
                        input: {},
                      });
                    const old = query.data;
                    cache.setQueryData(
                      key,
                      old
                        ? {
                            ...old,
                            selected: backend.id,
                            effective: backend.id,
                          }
                        : old
                    );
                    void transport.client.settings.execBackend
                      .set({ backend: backend.id })
                      .then((value) => cache.setQueryData(key, value))
                      .catch((e) => {
                        cache.setQueryData(key, old);
                        showError(errorText(e));
                      });
                  }}
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
                void transport.client.terminal.shell
                  .set({
                    shell:
                      selected as import("#shared/terminal-shells").TerminalShellId,
                  })
                  .then((value) =>
                    cache.setQueryData(
                      transport.orpc.terminal.shell.get.queryKey({ input: {} }),
                      value
                    )
                  )
                  .catch((e) => showError(errorText(e)))
              }
            />
          </SettingRow>
        )}
        <SettingRow
          id="sandbox"
          title={t("phase5.sandbox")}
          detail={sandbox.data?.reason ?? undefined}
        >
          <StatePill>
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
export const BrowserPage = () => {
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
  const mutate = (
    call: ReturnType<typeof transport.client.browser.setEnabled>
  ) =>
    void call
      .then((value) =>
        cache.setQueryData(
          transport.orpc.browser.status.queryKey({ input: {} }),
          value
        )
      )
      .catch((e) => showError(errorText(e)));
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
            onCheckedChange={(enabled) =>
              mutate(transport.client.browser.setEnabled({ enabled }))
            }
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
              mutate(
                transport.client.browser.setEngine({
                  engine: engine as "builtin" | "chrome",
                })
              )
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
                onClick={() =>
                  mutate(
                    status.chrome.connected
                      ? transport.client.browser.chrome.disconnect({})
                      : transport.client.browser.chrome.connect({})
                  )
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
                onClick={() => {
                  mutate(
                    transport.client.browser.chrome.setExtensionToken({
                      token: token.trim(),
                    })
                  );
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
              mutate(
                transport.client.browser.permissions.setApproval({
                  approval: approval as "ask" | "always",
                })
              )
            }
          />
        </SettingRow>
        <SettingRow id="browserData" title={t("phase5.settings.browserData")}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void transport.client.browser
                .clearData({})
                .then(() => showInfo(t("phase5.cleared")))
                .catch((e) => showError(errorText(e)))
            }
          >
            {t("phase5.clearAll")}
          </Button>
        </SettingRow>
      </GroupCard>
    </AreaPage>
  );
};
export const DevicesPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const query = useQuery(
    transport.orpc.devices.status.queryOptions({ input: {} })
  );
  const mutate = (
    call: ReturnType<typeof transport.client.devices.setEnabled>
  ) =>
    void call
      .then((result) =>
        cache.setQueryData(
          transport.orpc.devices.status.queryKey({ input: {} }),
          result
        )
      )
      .catch((e) => showError(errorText(e)));
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
            onCheckedChange={(enabled) =>
              mutate(transport.client.devices.setEnabled({ enabled }))
            }
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
                onClick={() =>
                  void transport.client.devices
                    .installMaestro({})
                    .then(() =>
                      cache.invalidateQueries({
                        queryKey: transport.orpc.devices.status.queryKey({
                          input: {},
                        }),
                      })
                    )
                    .catch((e) => showError(errorText(e)))
                }
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
              mutate(
                transport.client.devices.setApproval({
                  approval: approval as "ask" | "always",
                })
              )
            }
          />
        </SettingRow>
      </GroupCard>
    </AreaPage>
  );
};
