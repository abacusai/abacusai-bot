import { AlertCircle, Check, ChevronDown, Folder, Plus } from "lucide-react";
import { type JSX } from "react";
import { useTranslation } from "react-i18next";

import type {
  WorktreeDraftEnvironment,
  WorktreeListItem,
} from "#shared/contracts";

import { Button, Spinner } from "../ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

const displayName = (worktree: WorktreeListItem): string => worktree.name;

export const WorktreePicker = ({
  worktrees,
  activeWorktreeId,
  environment,
  allowNewWorktree,
  disabled = false,
  isPending = false,
  error = null,
  onSelectEnvironment,
}: {
  worktrees: WorktreeListItem[];
  activeWorktreeId: string | null;
  environment: WorktreeDraftEnvironment;
  allowNewWorktree: boolean;
  disabled?: boolean;
  isPending?: boolean;
  error?: Error | null;
  onSelectEnvironment: (environment: WorktreeDraftEnvironment) => void;
}): JSX.Element => {
  const { t } = useTranslation();
  const selectedId =
    environment.kind === "existing" ? environment.worktreeId : activeWorktreeId;
  const active = worktrees.find((worktree) => worktree.id === selectedId);
  const label =
    environment.kind === "new"
      ? t("workspace.worktree.create")
      : active == null
        ? t("workspace.worktree.currentCheckout")
        : displayName(active);

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Tooltip>
        <TooltipTrigger render={<div className="inline-flex min-w-0" />}>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  data-id="local-code-worktree-selector"
                  aria-label={t("workspace.worktree.select")}
                  aria-invalid={error != null}
                  disabled={disabled || isPending}
                  className="max-w-48 min-w-0 justify-start"
                />
              }
            >
              {isPending ? <Spinner /> : <Folder />}
              <span className="truncate">{label}</span>
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top" className="min-w-64">
              <DropdownMenuItem
                data-id="local-code-worktree-option-current"
                onClick={() => onSelectEnvironment({ kind: "current" })}
              >
                <Folder />
                <span className="min-w-0 flex-1 truncate">
                  {t("workspace.worktree.currentCheckout")}
                </span>
                {environment.kind === "current" && <Check />}
              </DropdownMenuItem>
              {worktrees
                .filter((worktree) => !worktree.isCurrent)
                .map((worktree) => (
                  <DropdownMenuItem
                    key={worktree.id}
                    data-id={`local-code-worktree-option-${worktree.id}`}
                    onClick={() =>
                      onSelectEnvironment({
                        kind: "existing",
                        worktreeId: worktree.id,
                      })
                    }
                  >
                    <Folder />
                    <span className="min-w-0 flex-1 truncate">
                      {displayName(worktree)}
                    </span>
                    {environment.kind === "existing" &&
                      environment.worktreeId === worktree.id && <Check />}
                  </DropdownMenuItem>
                ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-id="local-code-worktree-create"
                disabled={!allowNewWorktree}
                onClick={() =>
                  onSelectEnvironment({ kind: "new", baseRef: "HEAD" })
                }
              >
                <Plus />
                {t("workspace.worktree.create")}
                {environment.kind === "new" && <Check />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TooltipTrigger>
        <TooltipContent>{t("workspace.worktree.description")}</TooltipContent>
      </Tooltip>
      {error != null && (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="alert"
                aria-label={t("workspace.worktree.error")}
                className="text-destructive inline-flex"
              />
            }
          >
            <AlertCircle className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>{error.message}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};
