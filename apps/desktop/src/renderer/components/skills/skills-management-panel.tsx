import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  LoaderCircle,
  CloudDownload,
  File,
  FileUp,
  Folder,
  Search,
  Pencil,
  RotateCw,
  Store,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

import type {
  InstalledSkill,
  MarketplaceSkill,
  SkillSource,
} from "#shared/skills-types";

import { settingsQueryKeys } from "../../lib/settings-query-keys";
import { useCodeFolderContext } from "../../stores/code-folder-context";
import { useWorkspaceStore } from "../../stores/code-store";
import { useSessionSkillsStore } from "../../stores/session-skills-store";
import { Dialog } from "../common/dialog";
import {
  Button,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Spinner,
} from "../ui";
import {
  Dialog as ModalDialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "../ui/item";

/** Re-scan the slash-command picker so a disk mutation shows without a restart. */
function notifySkillsChanged(): void {
  useSessionSkillsStore.getState().bumpRefresh();
}

/**
 * Skill management as a panel in the Capabilities view's Skills tab: the tab
 * is the container, so no backdrop, close button, or Done.
 */

// Builtin skills are never surfaced here; the disk scan only returns these.
const SOURCE_ORDER: SkillSource[] = ["project", "global"];

/** The folder to scan for project skills; installs are global-only regardless. */
async function resolveWorkspacePath(): Promise<string | null> {
  const wsId = useWorkspaceStore.getState().activeWorkspaceId;
  if (wsId != null) {
    try {
      const meta = await window.api?.agent?.getMetadata?.();
      const ws = meta?.workspaces?.find(
        (w: { id: string; path?: string }) => w.id === wsId
      );
      if (ws?.path != null) return ws.path;
    } catch {
      /* fall through to the picked folder */
    }
  }
  // Before a workspace is registered, the picked folder lives in codeFolderContext.
  return useCodeFolderContext.getState().currentFolder ?? null;
}

export const SkillsManagementPanel = (): React.ReactElement => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const activeWorkspaceId = useWorkspaceStore(
    (state) => state.activeWorkspaceId
  );
  const [error, setError] = useState<string | null>(null);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [confirmSkill, setConfirmSkill] = useState<InstalledSkill | null>(null);
  // Running agents only re-read skills at process startup.
  const [needsRestart, setNeedsRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const skillsQuery = useQuery({
    queryKey: settingsQueryKeys.skills.installed(activeWorkspaceId),
    staleTime: 30_000,
    queryFn: async () => {
      const workspacePath = await resolveWorkspacePath();
      const result = await window.api?.skills?.listInstalled?.({
        workspacePath: workspacePath ?? undefined,
      });
      return { workspacePath, skills: result?.skills ?? [] };
    },
  });
  const workspacePath = skillsQuery.data?.workspacePath ?? null;
  const skills = skillsQuery.data?.skills ?? [];
  const loading = skillsQuery.isPending;
  const refreshSkills = async (): Promise<void> => {
    await queryClient.invalidateQueries({
      queryKey: settingsQueryKeys.skills.all,
    });
  };

  const handleRestart = async (): Promise<void> => {
    setRestarting(true);
    try {
      await window.api?.restartApp?.();
    } catch {
      setRestarting(false);
    }
  };

  const handleEdit = async (skill: InstalledSkill): Promise<void> => {
    const res = await window.api?.skills?.openFile?.({
      path: skill.path,
      workspacePath: workspacePath ?? undefined,
    });
    if (res?.success !== true) setError(res?.error ?? t("skills.openFailed"));
  };

  // True closes the confirmation dialog; an error string keeps it open.
  const performUninstall = async (
    skill: InstalledSkill
  ): Promise<boolean | string> => {
    const key = settingsQueryKeys.skills.installed(activeWorkspaceId);
    const previous = queryClient.getQueryData<{
      workspacePath: string | null;
      skills: InstalledSkill[];
    }>(key);
    queryClient.setQueryData(key, (current: typeof previous) =>
      current == null
        ? current
        : {
            ...current,
            skills: current.skills.filter((item) => item.path !== skill.path),
          }
    );
    const res = await window.api?.skills?.remove?.({
      path: skill.path,
      workspacePath: workspacePath ?? undefined,
    });
    if (res?.success === true) {
      notifySkillsChanged();
      setNeedsRestart(true);
      await refreshSkills();
      return true;
    }
    queryClient.setQueryData(key, previous);
    return res?.error ?? t("skills.removeFailed");
  };

  // Import from disk, always at global scope; the native picker is main-side.
  const uploadMutation = useMutation({
    mutationFn: (kind: "file" | "folder") =>
      window.api?.skills?.importLocal?.({ kind }),
    onMutate: () => setError(null),
    onSuccess: async (result) => {
      if (result?.cancelled === true) return;
      if (result?.success !== true) {
        setError(result?.error ?? t("skills.uploadFailed"));
        return;
      }
      notifySkillsChanged();
      setNeedsRestart(true);
      await refreshSkills();
    },
    onError: (cause) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
  });

  const handleUpload = (kind: "file" | "folder"): void => {
    uploadMutation.mutate(kind);
  };

  const grouped = SOURCE_ORDER.map((source) => ({
    source,
    items: skills.filter((s) => s.source === source),
  }));
  const hasAny = skills.length > 0;

  return (
    <>
      <div
        className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
        data-id="skills-management-panel"
      >
        <>
          <div className="scroll-fade-y scrollbar-autohide mx-auto min-h-0 w-full max-w-4xl flex-1 overflow-y-auto px-6 py-4">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Spinner fontSize={20} />
              </div>
            ) : !hasAny ? (
              <div className="text-muted-foreground py-8 text-center text-sm">
                {t("skills.noSkills")}
              </div>
            ) : (
              <div className="space-y-4">
                {grouped.map(({ source, items }) =>
                  items.length === 0 ? null : (
                    <div key={source} className="space-y-1.5">
                      <p className="text-muted-foreground text-xs font-medium tracking-widest uppercase">
                        {t(`skills.sources.${source}`)}
                      </p>
                      <div className="space-y-1.5">
                        {items.map((skill) => (
                          <SkillRow
                            key={`${source}:${skill.id}`}
                            skill={skill}
                            onEdit={() => void handleEdit(skill)}
                            onUninstall={() => setConfirmSkill(skill)}
                          />
                        ))}
                      </div>
                    </div>
                  )
                )}
              </div>
            )}
          </div>

          {error != null && (
            <div className="mx-auto w-full max-w-4xl shrink-0 px-6 py-2">
              <div className="text-destructive text-sm">{error}</div>
            </div>
          )}

          {needsRestart && (
            <div className="mx-auto w-full max-w-4xl shrink-0 px-6 pb-2">
              <Item
                variant="outline"
                className="bg-primary/10 border-primary/30"
                data-id="skills-restart-banner"
              >
                <ItemMedia variant="icon">
                  <RotateCw className="text-primary" />
                </ItemMedia>
                <ItemContent>
                  <ItemDescription>{t("skills.restartBanner")}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    onClick={() => void handleRestart()}
                    disabled={restarting}
                    data-id="skills-restart-btn"
                  >
                    {restarting ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <RotateCw />
                    )}
                    {t("skills.restartNow")}
                  </Button>
                </ItemActions>
              </Item>
            </div>
          )}

          <div className="border-border order-first mx-auto flex w-full max-w-4xl shrink-0 justify-between border-b px-6 py-4">
            <div className="flex items-center gap-2">
              <Button
                onClick={() => {
                  setError(null);
                  setMarketplaceOpen(true);
                }}
                data-id="skills-browse-marketplace-btn"
              >
                <Store />
                {t("skills.browseMarketplace")}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="secondary"
                      disabled={uploadMutation.isPending}
                      data-id="skills-upload-btn"
                      aria-label={t("skills.uploadTitle")}
                    />
                  }
                  onClick={() => setError(null)}
                >
                  {uploadMutation.isPending ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <FileUp />
                  )}
                  {t("skills.upload")}
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="start">
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      onClick={() => handleUpload("file")}
                      data-id="skills-upload-file"
                    >
                      <File />
                      {t("skills.uploadFromFile")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => handleUpload("folder")}
                      data-id="skills-upload-folder"
                    >
                      <Folder />
                      {t("skills.uploadFromFolder")}
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </>
      </div>
      <ModalDialog open={marketplaceOpen} onOpenChange={setMarketplaceOpen}>
        <DialogContent className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("skills.marketplaceTitle")}</DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col">
            <MarketplaceView
              onInstalled={() => {
                setNeedsRestart(true);
                void refreshSkills();
              }}
            />
          </div>
        </DialogContent>
      </ModalDialog>

      <Dialog
        isOpen={confirmSkill != null}
        onClose={() => setConfirmSkill(null)}
        icon={TriangleAlert}
        iconColor="text-destructive"
        title={t("skills.uninstall")}
        description={
          confirmSkill != null
            ? t("skills.uninstallConfirm", { id: confirmSkill.id })
            : ""
        }
        data-id="skills-uninstall-confirm"
        buttons={[
          {
            label: t("skills.cancel"),
            variant: "secondary",
            onClick: () => setConfirmSkill(null),
          },
          {
            label: t("skills.uninstall"),
            variant: "destructive",
            onClick: () =>
              confirmSkill != null
                ? performUninstall(confirmSkill)
                : Promise.resolve(false),
          },
        ]}
      />
    </>
  );
};

interface SkillRowProps {
  skill: InstalledSkill;
  onEdit: () => void;
  onUninstall?: () => void;
}

const SkillRow = ({
  skill,
  onEdit,
  onUninstall,
}: SkillRowProps): React.ReactElement => {
  const { t } = useTranslation();
  return (
    <Item
      variant="outline"
      className="bg-sidebar/60 min-w-0 overflow-hidden"
      data-id={`skill-row-${skill.id}`}
    >
      <ItemContent className="min-w-0">
        <ItemTitle className="min-w-0 flex-wrap">
          <span className="min-w-0 break-all">/{skill.id}</span>
          {skill.argumentHint != null && (
            <span className="text-muted-foreground font-mono text-xs">
              {skill.argumentHint}
            </span>
          )}
        </ItemTitle>
        <ItemDescription className="truncate">
          {skill.description}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="shrink-0">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onEdit}
          data-id={`skill-edit-${skill.id}`}
          aria-label={t("skills.edit")}
        >
          <Pencil />
        </Button>
        {onUninstall != null && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onUninstall}
            className="hover:text-destructive"
            data-id={`skill-uninstall-${skill.id}`}
            aria-label={t("skills.uninstall")}
          >
            <Trash2 />
          </Button>
        )}
      </ItemActions>
    </Item>
  );
};

interface MarketplaceViewProps {
  onInstalled: () => void;
}

const MarketplaceView = ({
  onInstalled,
}: MarketplaceViewProps): React.ReactElement => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [installed, setInstalled] = useState<Set<string>>(new Set());

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query), 350);
    return () => clearTimeout(id);
  }, [query]);

  const normalizedQuery = debouncedQuery.trim();
  const searchQuery = useQuery({
    queryKey: settingsQueryKeys.skills.marketplace(normalizedQuery),
    enabled: normalizedQuery.length > 0,
    staleTime: 5 * 60_000,
    queryFn: () =>
      window.api?.skills?.searchMarketplace?.({ query: normalizedQuery }),
  });
  const results = searchQuery.data?.skills ?? [];
  const fetching = searchQuery.isFetching;
  const searchError = searchQuery.isError
    ? "error"
    : (searchQuery.data?.error ?? null);

  // Always global scope, so the skill is reachable via ~/.abacusai-bot/skills.
  const installMutation = useMutation({
    mutationFn: async (skill: MarketplaceSkill) => ({
      skill,
      result: await window.api?.skills?.install?.({
        skillId: skill.skillId,
        source: skill.source,
        name: skill.name,
        scope: "global",
      }),
    }),
    onSuccess: ({ skill, result }) => {
      if (result?.success !== true) return;
      setInstalled((current) => new Set(current).add(skill.id));
      notifySkillsChanged();
      onInstalled();
    },
  });

  const installError = (skill: MarketplaceSkill): string | null => {
    if (installMutation.variables?.id !== skill.id) return null;
    if (installMutation.error != null) {
      return installMutation.error instanceof Error
        ? installMutation.error.message
        : String(installMutation.error);
    }
    const result = installMutation.data?.result;
    return result?.success === false
      ? (result.error ?? t("skills.installFailed"))
      : null;
  };

  const renderInstallAction = (skill: MarketplaceSkill): React.ReactElement => {
    const key = skill.id;
    if (installed.has(key)) {
      return (
        <span
          className="text-muted-foreground flex items-center gap-1 text-xs"
          data-id={`marketplace-installed-${skill.id}`}
        >
          <Check className="text-green-500" />
          {t("skills.installed")}
        </span>
      );
    }
    if (
      installMutation.isPending &&
      installMutation.variables?.id === skill.id
    ) {
      return <Spinner fontSize={12} />;
    }
    return (
      <Button
        size="sm"
        onClick={() => installMutation.mutate(skill)}
        data-id={`marketplace-install-${skill.id}`}
        title={t("skills.installGlobalTitle")}
      >
        {t("skills.install")}
      </Button>
    );
  };

  return (
    <>
      <div className="mx-auto w-full max-w-4xl shrink-0 px-6 pt-4">
        <InputGroup>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("skills.searchPlaceholder")}
            data-id="skills-marketplace-search"
          />
        </InputGroup>
      </div>

      <div className="scroll-fade-y scrollbar-autohide mx-auto min-h-0 w-full max-w-4xl flex-1 overflow-y-auto px-6 py-3">
        {fetching ? (
          <div className="flex items-center justify-center py-8">
            <Spinner fontSize={20} />
          </div>
        ) : debouncedQuery.trim() === "" ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {t("skills.searchPrompt")}
          </p>
        ) : searchError != null ? (
          <p
            className="text-destructive py-8 text-center text-sm"
            data-id="skills-marketplace-search-error"
          >
            {t("skills.searchError")}
          </p>
        ) : results.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {t("skills.noResults")}
          </p>
        ) : (
          <div className="space-y-1.5">
            {results.map((skill) => (
              <Item
                key={skill.id}
                variant="outline"
                className="bg-sidebar/60 min-w-0 overflow-hidden"
                data-id={`marketplace-skill-${skill.id}`}
              >
                <ItemContent className="min-w-0">
                  <ItemTitle className="min-w-0 flex-wrap">
                    <span className="min-w-0 break-all">/{skill.skillId}</span>
                    <span className="text-muted-foreground max-w-full truncate font-mono text-[0.625rem]">
                      {skill.source}
                    </span>
                  </ItemTitle>
                  <ItemDescription className="flex items-center gap-1 text-[0.625rem]">
                    <CloudDownload />
                    {t("skills.installs", { count: skill.installs })}
                  </ItemDescription>
                  {installError(skill) != null && (
                    <p className="text-destructive mt-0.5 text-[0.625rem]">
                      {installError(skill)}
                    </p>
                  )}
                </ItemContent>
                <ItemActions className="shrink-0">
                  {renderInstallAction(skill)}
                </ItemActions>
              </Item>
            ))}
          </div>
        )}
      </div>

      <div className="border-border text-muted-foreground shrink-0 border-t px-6 py-3 text-xs">
        {t("skills.poweredBy")}{" "}
        <Button
          variant="link"
          size="sm"
          onClick={() => void window.api?.openExternal?.("https://skills.sh")}
          data-id="skills-marketplace-link"
        >
          skills.sh
        </Button>
      </div>
    </>
  );
};
