import { useLiveQuery } from "@tanstack/react-db";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmAction } from "#next/components/form-kit/confirm";
import { SettingSwitch, Choice } from "#next/components/form-kit/controls";
import {
  AreaPage,
  GroupCard,
  SettingRow,
  StatePill,
} from "#next/components/form-kit/page";
import { useCollections } from "#next/data/db";
import { usePrefs } from "#next/data/db/prefs";
import { AppLink } from "#next/lib/navigation/app-link";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { showError } from "#next/lib/toast";
import { useAppContext, foldSearch } from "#next/lib/use-app-context";
import { useDebouncedValue } from "#next/lib/use-debounced-value";
import { Button } from "#next/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "#next/ui/dialog";
import { Input } from "#next/ui/input";
import { TOOLSETS_FOR_DISPLAY } from "#shared/toolsets";
/** @public Shared phase-5 integration API. */
export const selectSkills = (
  live: readonly unknown[] | undefined,
  baseline: readonly unknown[]
) => (live?.length ? live : baseline);
export const SkillsPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const prefs = usePrefs();
  const c = useCollections();
  const workspaces = useLiveQuery(c.workspaces).data ?? [];
  const search = useSearch({ strict: false }) as {
    workspace?: string;
    marketplace?: boolean;
  };
  const workspace = workspaces.find(
    (w) => w.id === (search.workspace ?? prefs.lastPickedWorkspaceId)
  );
  const workspacePath = workspace?.path;
  const query = useQuery({
    ...transport.orpc.skills.listInstalled.queryOptions({
      input: { workspacePath },
    }),
    staleTime: 30000,
  });
  const cache = useQueryClient();
  const navigate = useAppNavigate();
  const [restart, setRestart] = useState(false);
  const changed = async (result: {
    success: boolean;
    error?: string;
    cancelled?: boolean;
  }) => {
    if (result.cancelled) return;
    if (!result.success) throw new Error(result.error ?? t("phase5.failed"));
    setRestart(true);
    await cache.invalidateQueries({
      queryKey: transport.orpc.skills.listInstalled.key(),
    });
  };
  return (
    <>
      <AreaPage
        title={t("library.pages.skills")}
        description={t("phase5.skillsDescription")}
        actions={
          <Button
            size="sm"
            onClick={() =>
              void navigate({
                to: "/library/skills",
                search: (p) => ({ ...p, marketplace: true }),
                transition: "none",
              })
            }
          >
            {t("phase5.marketplace")}
          </Button>
        }
      >
        <SettingRow id="skillsWorkspace" title={t("phase5.workspace")}>
          <Choice
            id="skillsWorkspace"
            value={workspace?.id ?? ""}
            options={[
              { value: "", label: t("phase5.global") },
              ...workspaces
                .filter((w) => w.kind == null || w.kind === "auto")
                .map((w) => ({ value: w.id, label: w.label ?? w.path })),
            ]}
            onChange={(workspace) =>
              void navigate({
                to: "/library/skills",
                search: { workspace: workspace || "global" },
                transition: "none",
              })
            }
          />
        </SettingRow>
        <div className="flex gap-2">
          {(["folder", "file"] as const).map((kind) => (
            <Button
              key={kind}
              size="sm"
              variant="secondary"
              onClick={() =>
                void transport.client.skills
                  .importLocal({ kind })
                  .then(changed)
                  .catch(() => showError(t("phase5.failed")))
              }
            >
              {t(`phase5.skillImport.${kind}`)}
            </Button>
          ))}
        </div>
        {["project", "global"].map((source) => (
          <section key={source}>
            <h2 className="mb-2 text-sm font-semibold">
              {t(source === "project" ? "phase5.workspace" : "phase5.global")}
            </h2>
            <GroupCard>
              {query.data?.skills
                .filter((s) => s.source === source)
                .map((s) => (
                  <SettingRow
                    key={s.path}
                    id={s.id}
                    title={`/${s.id}`}
                    detail={s.description}
                  >
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() =>
                        void transport.client.skills
                          .openFile({ path: s.path, workspacePath })
                          .then((result) => {
                            if (!result.success)
                              showError(result.error ?? t("phase5.failed"));
                          })
                      }
                    >
                      {t("phase5.editSkill")}
                    </Button>
                    <ConfirmAction
                      title={t("phase5.uninstallSkill")}
                      description={t("phase5.uninstallSkillDescription", {
                        id: s.id,
                      })}
                      label={t("phase5.uninstall")}
                      onConfirm={() =>
                        transport.client.skills
                          .remove({ path: s.path, workspacePath })
                          .then(changed)
                      }
                    />
                  </SettingRow>
                ))}
            </GroupCard>
          </section>
        ))}
        {restart && (
          <div role="status">
            <p>{t("phase5.restartSkills")}</p>
            <Button onClick={() => void transport.client.system.restart({})}>
              {t("phase5.restartNow")}
            </Button>
          </div>
        )}
      </AreaPage>
      {search.marketplace && (
        <MarketplaceDialog onInstalled={() => setRestart(true)} />
      )}
    </>
  );
};
export const MarketplaceDialog = ({ onInstalled }: { onInstalled(): void }) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const navigate = useAppNavigate();
  const [q, setQ] = useState("");
  const queryText = useDebouncedValue(q, 350);
  const [pending, setPending] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string[]>([]);
  const result = useQuery({
    ...transport.orpc.skills.search.queryOptions({
      input: { query: queryText },
    }),
    enabled: queryText.trim().length > 0,
    staleTime: 300000,
  });
  const close = () =>
    void navigate({
      to: "/library/skills",
      search: (p) => ({ ...p, marketplace: undefined }),
      transition: "none",
    });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-h-[80vh] overflow-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{t("phase5.marketplace")}</DialogTitle>
          <DialogDescription>{t("phase5.searchSkills")}</DialogDescription>
        </DialogHeader>
        <Input
          aria-label={t("phase5.searchSkills")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {result.data?.error && <p role="alert">{result.data.error}</p>}
        {result.data?.skills.map((s) => (
          <SettingRow
            key={s.id}
            id={s.id}
            title={`/${s.skillId}`}
            detail={`${s.source} · ${s.installs}`}
          >
            <Button
              size="sm"
              disabled={pending != null || installed.includes(s.id)}
              onClick={() => {
                setPending(s.id);
                void transport.client.skills
                  .install({
                    skillId: s.skillId,
                    source: s.source,
                    name: s.name,
                    scope: "global",
                  })
                  .then(async (result) => {
                    if (!result.success) throw new Error(result.error);
                    setInstalled((ids) => [...ids, s.id]);
                    onInstalled();
                    await cache.invalidateQueries({
                      queryKey: transport.orpc.skills.listInstalled.key(),
                    });
                  })
                  .catch((e) =>
                    showError(
                      e instanceof Error ? e.message : t("phase5.failed")
                    )
                  )
                  .finally(() => setPending(null));
              }}
            >
              {t(
                installed.includes(s.id) ? "phase5.installed" : "phase5.install"
              )}
            </Button>
          </SettingRow>
        ))}
        <Button
          variant="ghost"
          onClick={() =>
            void transport.client.system.openExternal({
              url: "https://skills.sh",
            })
          }
        >
          {t("phase5.poweredSkills")}
        </Button>
      </DialogContent>
    </Dialog>
  );
};
export const ToolsPage = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const query = useQuery(
    transport.orpc.settings.toolsets.get.queryOptions({ input: {} })
  );
  const cache = useQueryClient();
  const [q, setQ] = useState("");
  const change = async (id: string, enabled: boolean) => {
    const key = transport.orpc.settings.toolsets.get.queryKey({ input: {} });
    const before = query.data;
    cache.setQueryData(key, { ...before, [id]: enabled });
    try {
      cache.setQueryData(
        key,
        await transport.client.settings.toolsets.setEnabled({
          toolsetId: id,
          enabled,
        })
      );
    } catch {
      cache.setQueryData(key, before);
      showError(t("phase5.failed"));
    }
  };
  return (
    <AreaPage
      title={t("library.pages.tools")}
      description={t("phase5.toolsDescription")}
    >
      <Input
        aria-label={t("phase5.searchTools")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <GroupCard>
        {TOOLSETS_FOR_DISPLAY.filter((s) =>
          foldSearch(
            s.id +
              " " +
              t(`capabilities.toolsets.${s.labelKey}`) +
              " " +
              s.tools.map((t) => t.name).join(" ")
          ).includes(foldSearch(q))
        ).map((s) => (
          <SettingRow
            key={s.id}
            id={s.id}
            title={t(`capabilities.toolsets.${s.labelKey}`)}
            detail={s.tools.map((tool) => tool.name).join(", ")}
          >
            <AppLink
              to="/library/tools/$toolsetId"
              params={{ toolsetId: s.id }}
            >
              {t("phase5.details")}
            </AppLink>
            {s.alwaysOn || s.status === "planned" ? (
              <StatePill>
                {t(s.alwaysOn ? "phase5.alwaysOn" : "phase5.planned")}
              </StatePill>
            ) : (
              <SettingSwitch
                id={s.id}
                checked={query.data?.[s.id] !== false}
                onCheckedChange={(enabled) => void change(s.id, enabled)}
              />
            )}
          </SettingRow>
        ))}
      </GroupCard>
    </AreaPage>
  );
};
export const ToolsetPage = ({ toolsetName }: { toolsetName: string }) => {
  const { t } = useTranslation();
  const set = TOOLSETS_FOR_DISPLAY.find((s) => s.id === toolsetName);
  return (
    <AreaPage
      title={set ? t(`capabilities.toolsets.${set.labelKey}`) : toolsetName}
    >
      <AppLink to="/library/tools">{t("phase5.allTools")}</AppLink>
      {set?.tools.map((tool) => (
        <SettingRow
          key={tool.name}
          id={tool.name}
          title={tool.name}
          detail={t(`capabilities.toolDescriptions.${tool.name}`)}
        >
          <span />
        </SettingRow>
      ))}
      {set?.id === "terminal" && (
        <AppLink to="/settings/environment" transition="settings-in">
          {t("phase5.executionShell")}
        </AppLink>
      )}
    </AreaPage>
  );
};
