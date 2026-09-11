import { Check, ChevronDown, Folder, FolderPlus } from "lucide-react";
import { type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { WorkspaceListItem } from "#shared/contracts";

import { Button } from "../ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

const basename = (path: string): string => {
  const parts = path.split(/[/\\]/);
  return parts.at(-1) || path;
};

export const WorkspacePicker = ({
  workspaces,
  activeWorkspaceId,
  onSwitchWorkspace,
  onAddWorkspace,
  variant = "workspace",
}: {
  workspaces: WorkspaceListItem[];
  activeWorkspaceId: string | null;
  onSwitchWorkspace: (workspaceId: string) => void;
  onAddWorkspace: () => void;
  variant?: "workspace" | "checkout" | "titlebar";
}): JSX.Element => {
  const { t } = useTranslation();
  const active = workspaces.find(
    (workspace) => workspace.id === activeWorkspaceId
  );
  // A routine's folder is a workspace so its runs have somewhere to stand,
  // not a place the user works. It is never offered.
  const offered = workspaces.filter(
    (workspace) => workspace.kind !== "routine"
  );
  const name =
    active?.kind === "auto"
      ? t("workspace.autoWorkspace")
      : active?.path != null
        ? basename(active.path)
        : (active?.label ?? t("workspace.welcome.selectWorkspace"));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            data-id={`local-code-${variant}-picker`}
            aria-label={t("workspace.welcome.switchWorkspace", {
              workspace: name,
            })}
            className={
              variant === "workspace"
                ? // Capped in `ch` rather than rem: the heading renders at 24px
                  // and 30px, so a fixed 16rem showed noticeably fewer
                  // characters at the larger size — and how many characters of
                  // their folder name a user sees is the whole point of the
                  // cap. 24ch is about eight more than the 16rem it replaces.
                  "bg-muted/50 hover:bg-muted h-auto max-w-[24ch] min-w-0 gap-1.5 rounded-lg border border-transparent px-2 py-1 text-2xl font-normal @2xl:text-3xl [&_svg]:size-[1em]"
                : variant === "titlebar"
                  ? "text-muted-foreground hover:text-foreground h-6 max-w-40 min-w-0 justify-start gap-1 px-1.5 text-xs font-normal [&_svg]:size-3.5"
                  : "max-w-48 min-w-0 justify-start"
            }
          />
        }
      >
        <Folder />
        <span
          // The name is capped, so the whole of it — and which folder it is,
          // when two projects share a basename — lives in the tooltip.
          title={active?.path ?? name}
          className={`truncate ${variant === "workspace" ? "underline decoration-dotted underline-offset-4" : ""}`}
        >
          {variant === "checkout" ? t("workspace.currentCheckout") : name}
        </span>
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="min-w-64">
        {offered.map((workspace) => {
          const workspaceName =
            workspace.kind === "auto"
              ? t("workspace.autoWorkspace")
              : workspace.path != null
                ? basename(workspace.path)
                : workspace.label;
          return (
            <DropdownMenuItem
              key={workspace.id}
              data-id={`local-code-workspace-option-${workspace.id}`}
              onClick={() => onSwitchWorkspace(workspace.id)}
            >
              <Folder />
              <span
                title={workspace.path ?? workspaceName}
                className="min-w-0 flex-1 truncate"
              >
                {workspaceName}
              </span>
              {workspace.id === activeWorkspaceId && <Check />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onAddWorkspace}>
          <FolderPlus />
          {t("workspace.welcome.addWorkspace")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
