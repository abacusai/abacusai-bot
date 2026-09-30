import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Folder, GitBranch, Laptop } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#next/data/db";
import { Button } from "#next/ui/button";
import { Input } from "#next/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "#next/ui/popover";

import {
  useSessionsTransport,
  usePickableWorkspaces,
  sessionsQueries,
  useWorkspace,
} from "../data/queries";
import type { StartDraft } from "../start/start-session";
export const SessionContextTray = ({
  workspaceId,
  sessionId,
  mode,
  busy = false,
  worktree,
  onWorkspace,
  onWorktree,
}: {
  workspaceId: string;
  sessionId?: string;
  mode?: string | null;
  busy?: boolean;
  worktree?: StartDraft["worktree"];
  onWorkspace?: (id: string) => void;
  onWorktree?: (choice: StartDraft["worktree"]) => void;
}) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const queryClient = useQueryClient();
  const db = useDb();
  const checkout = { workspaceId, ...(sessionId ? { sessionId } : {}) };
  const options = sessionsQueries(transport.orpc);
  const branch = useQuery(options.branch(checkout));
  const pr = useQuery(options.pr(checkout));
  const exec = useQuery(options.exec());
  const trees = useQuery(options.worktrees(workspaceId));
  const workspace = useWorkspace(workspaceId);
  const workspaces = usePickableWorkspaces();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    const path = await transport.client.system.dialog.openFolder({});
    if (!path) return;
    const result = await transport.client.workspaces.add({ path });
    await db.collections.workspaces.utils.resync();
    if (result.workspaceId) onWorkspace?.(result.workspaceId);
  };
  return (
    <div
      data-slot="session-context-tray"
      className="flex flex-wrap items-center justify-between gap-1 text-[13px]"
    >
      <div className="flex items-center gap-1">
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
              <p className="text-muted-foreground py-2 text-xs">
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
        {onWorktree && branch.data?.currentBranch ? (
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
        {sessionId ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={!pr.data}
            onClick={() =>
              pr.data &&
              void transport.client.system.openExternal({ url: pr.data.url })
            }
          >
            {pr.data ? `PR ${pr.data.number}` : t("sessions.tray.noPr")}
          </Button>
        ) : null}
      </div>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              title={busy ? t("sessions.tray.restartTarget") : undefined}
            />
          }
        >
          <Laptop />
          {exec.data?.effective === "docker"
            ? "Docker"
            : t("sessions.tray.local")}
          {mode === "AUTO" ? ` · ${t("sessions.tray.sandboxed")}` : ""}
        </PopoverTrigger>
        <PopoverContent className="w-80">
          {(["local", "docker"] as const).map((backend) => (
            <Button
              key={backend}
              variant="ghost"
              className="w-full justify-start"
              disabled={
                exec.data?.statuses.find((s) => s.id === backend)?.ready ===
                false
              }
              onClick={() =>
                void transport.client.settings.execBackend
                  .set({ backend })
                  .then((state) => {
                    queryClient.setQueryData(options.exec().queryKey, state);
                    if (state.effective !== backend)
                      setError(
                        t("sessions.tray.targetFallback", { name: backend })
                      );
                  })
              }
            >
              {backend === "local" ? t("sessions.tray.local") : "Docker"}
            </Button>
          ))}
          {exec.data && exec.data.selected !== exec.data.effective ? (
            <p role="status">
              {t("sessions.tray.targetFallback", { name: exec.data.selected })}
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
  const branches = useQuery(sessionsQueries(transport.orpc).branches(context));
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
