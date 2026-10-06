import { TOOLSETS_FOR_DISPLAY } from "@abacus-ai/contract/toolsets";
import { useLiveQuery } from "@tanstack/react-db";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmAction } from "#renderer/components/form-kit/confirm";
import { SettingSwitch, Choice } from "#renderer/components/form-kit/controls";
import {
  AreaPage,
  GroupCard,
  SettingRow,
  StatePill,
} from "#renderer/components/form-kit/page";
import { useCollections } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import {
  optimistic,
  succeeding,
  useMutation,
} from "#renderer/data/query-client";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
import { useAppContext, foldSearch } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "#renderer/ui/dialog";
import { Input } from "#renderer/ui/input";
/** Device and messaging tools run only on the desktop host. */
const VISIBLE_TOOLSETS = TOOLSETS_FOR_DISPLAY.filter(
  (s) => IS_ELECTRON || !["device", "messaging"].includes(s.id)
);
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
  // An import or removal changes the installed list; a cancelled picker
  // changes nothing.
  const changed = {
    onSuccess: async (result: object) => {
      if ("cancelled" in result && result.cancelled) return;
      setRestart(true);
      await cache.invalidateQueries({
        queryKey: transport.orpc.skills.listInstalled.key(),
      });
    },
  };
  const importLocal = useMutation(
    succeeding(
      transport.orpc.skills.importLocal.mutationOptions({
        ...changed,
        meta: { errorToast: "phase5.failed" },
      })
    )
  );
  const openFile = useMutation(
    succeeding(
      transport.orpc.skills.openFile.mutationOptions({
        meta: { errorToast: { reasonOr: "phase5.failed" } },
      })
    )
  );
  const removeSkill = useMutation(
    succeeding(transport.orpc.skills.remove.mutationOptions(changed))
  );
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
              disabled={importLocal.isPending}
              onClick={() => IS_ELECTRON && importLocal.mutate({ kind })}
            >
              {t(`phase5.skillImport.${kind}`)}
            </Button>
          ))}
        </div>
        {(workspacePath ? ["project", "global"] : ["global"]).map((source) => (
          <section key={source}>
            <h2 className="mb-2 text-sm font-semibold">
              {t(source === "project" ? "phase5.workspace" : "phase5.global")}
            </h2>
            <GroupCard>
              {!query.isPending &&
                !query.data?.skills.some(
                  (skill) => skill.source === source
                ) && (
                  <p className="text-muted-foreground p-4 text-sm">
                    {t("phase5.noInstalledSkills")}
                  </p>
                )}
              {query.data?.skills
                .filter((s) => s.source === source)
                .map((s) => (
                  <SettingRow
                    key={s.path}
                    id={s.id}
                    title={`/${s.id}`}
                    detail={s.description}
                  >
                    {IS_ELECTRON && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          openFile.mutate({ path: s.path, workspacePath })
                        }
                      >
                        {t("phase5.editSkill")}
                      </Button>
                    )}
                    <ConfirmAction
                      title={t("phase5.uninstallSkill")}
                      description={t("phase5.uninstallSkillDescription", {
                        id: s.id,
                      })}
                      label={t("phase5.uninstall")}
                      onConfirm={() =>
                        removeSkill.mutateAsync({ path: s.path, workspacePath })
                      }
                    />
                  </SettingRow>
                ))}
            </GroupCard>
          </section>
        ))}
        {IS_ELECTRON && restart && (
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
  const navigate = useAppNavigate();
  const [q, setQ] = useState("");
  // Delays the search input; the field itself stays immediate.
  const [queryText] = useDebouncedValue(q, { wait: 350 });
  const [installed, setInstalled] = useState<string[]>([]);
  const install = useMutation(
    succeeding(
      transport.orpc.skills.install.mutationOptions({
        onSuccess: () => onInstalled(),
        meta: {
          invalidates: [transport.orpc.skills.listInstalled.key()],
          errorToast: true,
        },
      })
    )
  );
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
              disabled={install.isPending || installed.includes(s.id)}
              onClick={() =>
                install.mutate(
                  {
                    skillId: s.skillId,
                    source: s.source,
                    name: s.name,
                    scope: "global",
                  },
                  { onSuccess: () => setInstalled((ids) => [...ids, s.id]) }
                )
              }
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
            void platformSystem(transport.client).openExternal({
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
  const [q, setQ] = useState("");
  const toggle = useMutation(
    transport.orpc.settings.toolsets.setEnabled.mutationOptions({
      ...optimistic(
        transport.orpc.settings.toolsets.get.queryKey({ input: {} }),
        (data, change: { toolsetId: string; enabled: boolean }) => ({
          ...data,
          [change.toolsetId]: change.enabled,
        })
      ),
      meta: { errorToast: "phase5.failed" },
    })
  );
  return (
    <AreaPage
      title={t("library.pages.tools")}
      description={t("phase5.toolsDescription")}
    >
      <Input
        aria-label={t("phase5.searchTools")}
        placeholder={t("phase5.searchTools")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <GroupCard>
        {VISIBLE_TOOLSETS.filter((s) =>
          foldSearch(
            s.id +
              " " +
              t(`capabilities.toolsets.${s.labelKey}.label`) +
              " " +
              s.tools.map((t) => t.name).join(" ")
          ).includes(foldSearch(q))
        ).map((s) => (
          <SettingRow
            key={s.id}
            id={s.id}
            title={t(`capabilities.toolsets.${s.labelKey}.label`)}
            detail={s.tools.map((tool) => tool.name).join(", ")}
          >
            <Button
              size="sm"
              variant="secondary"
              nativeButton={false}
              render={
                <AppLink
                  to="/library/tools/$toolsetId"
                  params={{ toolsetId: s.id }}
                />
              }
            >
              {t("phase5.details")}
            </Button>
            {s.alwaysOn || s.status === "planned" ? (
              <StatePill>
                {t(s.alwaysOn ? "phase5.alwaysOn" : "phase5.planned")}
              </StatePill>
            ) : (
              <SettingSwitch
                id={s.id}
                checked={query.data?.[s.id] !== false}
                onCheckedChange={(enabled) =>
                  toggle.mutate({ toolsetId: s.id, enabled })
                }
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
  const set = VISIBLE_TOOLSETS.find((s) => s.id === toolsetName);
  return (
    <AreaPage
      title={
        set
          ? t(`capabilities.toolsets.${set.labelKey}.label`)
          : t("phase5.unavailable")
      }
    >
      <AppLink to="/library/tools">{t("phase5.allTools")}</AppLink>
      {!set?.tools.length && (
        <p className="text-muted-foreground bg-card rounded-xl border p-4 text-sm">
          {t("phase5.toolsUnavailable")}
        </p>
      )}
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
