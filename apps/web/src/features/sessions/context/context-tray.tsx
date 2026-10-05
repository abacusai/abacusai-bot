import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder, GitBranch, Laptop } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#renderer/data/db";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
import { Button } from "#renderer/ui/button";
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from "#renderer/ui/hover-card";
import { Input } from "#renderer/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "#renderer/ui/popover";

import {
  useSessionsTransport,
  usePickableWorkspaces,
  useCheckoutQueries,
  useWorkspace,
} from "../data/queries";
import type { StartDraft } from "../start/start-session";
export const SessionContextTray = ({
  workspaceId,
  sessionId,
  mode,
  busy = false,
  agentRunning = false,
  worktree,
  onWorkspace,
  onWorktree,
}: {
  workspaceId: string;
  sessionId?: string;
  mode?: string | null;
  busy?: boolean;
  agentRunning?: boolean;
  worktree?: StartDraft["worktree"];
  onWorkspace?: (id: string) => void;
  onWorktree?: (choice: StartDraft["worktree"]) => void;
}) => {
  const { t } = useTranslation();
  const execLocked = busy || agentRunning;
  const transport = useSessionsTransport();
  const queryClient = useQueryClient();
  const db = useDb();
  const checkout = { workspaceId, ...(sessionId ? { sessionId } : {}) };
  const options = useCheckoutQueries(checkout);
  const branch = useQuery(options.branch(checkout));
  const pr = useQuery(options.pr(checkout));
  const exec = useQuery(options.exec());
  const trees = useQuery(options.worktrees(workspaceId));
  const workspace = useWorkspace(workspaceId);
  const workspaces = usePickableWorkspaces();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    const path = await platformSystem(transport.client).dialog.openFolder({});
    if (!path) return;
    const result = await transport.client.workspaces.add({ path });
    await db.collections.workspaces.utils.resync();
    if (result.workspaceId) onWorkspace?.(result.workspaceId);
  };
  return (
    <div
      data-slot="session-context-tray"
      className="phone:justify-start phone:flex-nowrap phone:overflow-x-auto phone:gap-1.5 phone:[&_button]:h-8 phone:[&_button]:shrink-0 phone:[&_button]:rounded-full phone:[&_button]:bg-foreground/[0.06] phone:[&_button]:px-3 no-scrollbar flex flex-wrap items-center justify-between gap-1 text-[13px]"
    >
      <div className="phone:shrink-0 phone:gap-1.5 flex items-center gap-1">
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("sessions.tray.workspaceLabel", {
                  name: workspace?.label,
                })}
              />
            }
          >
            <Folder />
            {workspace?.kind === "auto"
              ? t("sessions.tray.default")
              : workspace?.label}
          </PopoverTrigger>
          <PopoverContent className="w-80">
            <Input
              aria-label={t("sessions.tray.search")}
              placeholder={t("sessions.tray.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {!onWorkspace ? (
              <p className="text-foreground/75 py-2 text-xs">
                {t("sessions.tray.fixedWorkspace")}
              </p>
            ) : (
              workspaces
                .filter((w) =>
                  w.label.toLowerCase().includes(query.toLowerCase())
                )
                .map((w) => (
                  <Button
                    className="w-full justify-start"
                    key={w.id}
                    variant="ghost"
                    onClick={() => {
                      onWorkspace(w.id);
                      void db.updatePrefs({ lastPickedWorkspaceId: w.id });
                    }}
                  >
                    {w.kind === "auto" ? t("sessions.tray.default") : w.label}
                  </Button>
                ))
            )}
            {onWorkspace ? (
              <Button
                variant="ghost"
                onClick={() => void add().catch((e) => setError(String(e)))}
              >
                {t("sessions.tray.add")}
              </Button>
            ) : null}
          </PopoverContent>
        </Popover>
        {branch.data?.currentBranch ? (
          <Popover>
            <PopoverTrigger render={<Button variant="ghost" size="sm" />}>
              <GitBranch />
              <span className="font-mono text-xs">
                {branch.data.currentBranch}
              </span>
            </PopoverTrigger>
            <PopoverContent className="w-80">
              <BranchList
                workspaceId={workspaceId}
                sessionId={sessionId}
                busy={busy}
              />
            </PopoverContent>
          </Popover>
        ) : null}
        {onWorktree ? (
          <Popover>
            <PopoverTrigger render={<Button variant="ghost" size="sm" />}>
              {worktree?.kind === "new"
                ? t("sessions.tray.newWorktree")
                : worktree?.kind === "existing"
                  ? worktree.id
                  : t("sessions.tray.noWorktree")}
            </PopoverTrigger>
            <PopoverContent className="flex w-80 flex-col gap-1">
              <Button
                variant="ghost"
                onClick={() => onWorktree({ kind: "current" })}
              >
                {t("sessions.tray.noWorktree")}
              </Button>
              {trees.data?.worktrees?.map((tree) => (
                <Button
                  variant="ghost"
                  key={tree.id}
                  onClick={() => onWorktree({ kind: "existing", id: tree.id })}
                >
                  {tree.name}
                </Button>
              ))}
              <Button
                variant="ghost"
                disabled={!branch.data?.currentBranch}
                onClick={() =>
                  onWorktree({
                    kind: "new",
                    baseRef: branch.data!.currentBranch!,
                  })
                }
              >
                {t("sessions.tray.newWorktree")}
              </Button>
            </PopoverContent>
          </Popover>
        ) : null}
        {sessionId && pr.data ? (
          <HoverCard>
            <HoverCardTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void platformSystem(transport.client).openExternal({
                      url: pr.data!.url,
                    })
                  }
                />
              }
            >
              PR {pr.data.number}
            </HoverCardTrigger>
            <HoverCardContent>
              <p className="font-medium">{pr.data.title}</p>
              <p>{t(`sessions.pr.${pr.data.reviewState}`)}</p>
              <p className="font-mono">
                +{pr.data.additions} −{pr.data.deletions}
              </p>
              <ul>
                {pr.data.checks.map((check) => (
                  <li key={check.name}>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!check.url}
                      onClick={() =>
                        check.url &&
                        void platformSystem(transport.client).openExternal({
                          url: check.url,
                        })
                      }
                    >
                      {check.name} · {t(`sessions.pr.${check.status}`)}
                    </Button>
                  </li>
                ))}
              </ul>
            </HoverCardContent>
          </HoverCard>
        ) : sessionId ? (
          <span className="text-foreground/75 phone:inline-flex phone:h-8 phone:shrink-0 phone:items-center phone:rounded-full phone:bg-foreground/[0.06] phone:px-3">
            {t("sessions.tray.noPr")}
          </span>
        ) : null}
      </div>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              disabled={execLocked}
              title={execLocked ? t("sessions.tray.restartTarget") : undefined}
            />
          }
        >
          <Laptop />
          {exec.data?.effective === "docker"
            ? "Docker"
            : t(IS_ELECTRON ? "sessions.tray.local" : "web.hostLabel")}
          {mode === "AUTO" ? ` · ${t("sessions.tray.sandboxed")}` : ""}
        </PopoverTrigger>
        <PopoverContent className="w-80">
          {(["local", "docker"] as const).map((backend) => (
            <Button
              key={backend}
              variant="ghost"
              className="w-full justify-start"
              disabled={
                execLocked ||
                exec.data?.statuses.find((s) => s.id === backend)?.ready ===
                  false
              }
              onClick={() => {
                if (execLocked) return;
                void transport.client.settings.execBackend
                  .set({ backend })
                  .then((state) => {
                    queryClient.setQueryData(options.exec().queryKey, state);
                    if (state.effective !== backend)
                      setError(
                        t(
                          IS_ELECTRON
                            ? "sessions.tray.targetFallback"
                            : "web.targetFallback",
                          { name: backend }
                        )
                      );
                  })
                  .catch((error) => setError(String(error)));
              }}
            >
              {backend === "local"
                ? t(IS_ELECTRON ? "sessions.tray.local" : "web.hostLabel")
                : "Docker"}
            </Button>
          ))}
          {exec.data && exec.data.selected !== exec.data.effective ? (
            <p role="status">
              {t(
                IS_ELECTRON
                  ? "sessions.tray.targetFallback"
                  : "web.targetFallback",
                { name: exec.data.selected }
              )}
            </p>
          ) : null}
        </PopoverContent>
      </Popover>
      {error ? (
        <p role="alert" className="text-destructive w-full text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
};
const BranchList = ({
  workspaceId,
  sessionId,
  busy,
}: {
  workspaceId: string;
  sessionId?: string;
  busy: boolean;
}) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const qc = useQueryClient();
  const context = { workspaceId, ...(sessionId ? { sessionId } : {}) };
  const branches = useQuery(useCheckoutQueries(context).branches(context));
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const switchTo = async (name: string, create = false) => {
    try {
      await (
        create
          ? transport.client.git.createBranch
          : transport.client.git.switchBranch
      )({ branchName: name, context });
      await qc.invalidateQueries({ queryKey: transport.orpc.git.key() });
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <>
      <Input
        aria-label={t("sessions.tray.branchSearch")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {busy ? <p>{t("sessions.tray.stopFirst")}</p> : null}
      {branches.data?.branches
        ?.filter((b) => b.name.includes(query))
        .map((b) => (
          <Button
            key={b.name}
            variant="ghost"
            className="w-full justify-start"
            disabled={busy}
            onClick={() => void switchTo(b.name)}
          >
            {b.name}
          </Button>
        ))}
      {query ? (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => void switchTo(query, true)}
        >
          {t("sessions.tray.createBranch", { name: query })}
        </Button>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
};
