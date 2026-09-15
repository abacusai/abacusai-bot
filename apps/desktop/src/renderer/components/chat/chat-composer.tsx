import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUp,
  Check,
  CircleCheck,
  CircleX,
  Code,
  MousePointer2,
  Square,
  TriangleAlert,
} from "lucide-react";
import {
  ExternalLink,
  FileText,
  Folder,
  GitBranch,
  Paperclip,
  Plus,
  Upload,
  X,
} from "lucide-react";
import {
  Activity,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { SkillMetadata } from "#shared/agent-types";
import { AgentMode, AgentStatus } from "#shared/agent-types";
import type {
  PrInfo,
  PrReviewState,
  WorktreeDraftEnvironment,
  WorktreeListItem,
} from "#shared/contracts";
import { hasUsableModel, type ModelAvailability } from "#shared/models";

// The composer speaks the CLI's own decision union, not the legacy shared one.
import type {
  PermissionDecision,
  PermissionRequest,
} from "../../conversation/agent-types";
import type { TodoState } from "../../conversation/derivations";
import { workspaceConversationTransport } from "../../conversation/transport";
import { usePromptHistory } from "../../hooks/use-prompt-history";
import {
  formatFileMention,
  getMentionAtCursor,
  tokenize,
} from "../../lib/mentions";
import { workspaceQueryKeys } from "../../lib/query-keys";
import { filterSkills } from "../../utils/skill-utils";
import { Button, Spinner, Textarea } from "../ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "../ui/hover-card";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { BranchPicker } from "./branch-picker";
import { ComposerTasksBadge, ComposerTasksDrawer } from "./composer-tasks";
import { FileMentionPicker, type FileMentionItem } from "./file-mention-picker";
import { ModelPicker } from "./model-picker";
import { RuntimeModePicker } from "./runtime-mode-picker";
import { SlashCommandMenu } from "./slash-command-menu";
import { WorktreePicker } from "./worktree-picker";

// ─── Types ────────────────────────────────────────────────────────────────────

type LocalAttachment = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  file: File;
  previewUrl: string | null;
  /** Where the file lives on disk; null for pasted bytes. */
  path: string | null;
};

// A file on disk is referenced where it is; pasted bytes are written to
// <workspaceRoot>/.abacusai-bot/temp/. Either way the message gets an @-ref.
export type WorkspaceOutgoingAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  data: Uint8Array;
  path: string | null;
};

export type PendingPermissionInfo = {
  permissionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  workspaceId: string;
  sessionId: string;
  /**
   * The CLI's typed permission request: a discriminated union with
   * display-ready fields, preferred over the raw `toolInput` args (the legacy
   * `_permissionType` / `_deducedDirectory` keys are only a fallback).
   */
  request?: PermissionRequest;
};

export type ChatComposerProps = {
  /** Bumped by the panel to shake the model picker after a failed turn. */
  modelAttention?: number;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  inputValue: string;
  onInputValueChange: (value: string) => void;
  skills?: SkillMetadata[];
  onSend: (attachments: WorkspaceOutgoingAttachment[]) => Promise<void>;
  /** Whose up-arrow history this shows: the session or the new-session box. */
  historyScope: string;
  onStop?: () => void;
  isSendLoading: boolean;
  isStreaming: boolean;
  canSend: boolean;
  placeholder?: string | undefined;
  models: ModelAvailability[] | undefined;
  selectedModelValue: string;
  onSelectModel: (workspaceId: string | null, value: string) => void;
  selectedModeValue: AgentMode;
  /** False in a bot's chat, which runs at full permissions and says so. */
  canSelectMode?: boolean;
  /**
   * The message-app shape: one line, a + at the start, nothing under it. A
   * bot's chat has no mode, model or worktree to pick, and a three-row rig
   * around a message box is the app looking busy at the user's expense.
   */
  compact?: boolean;
  onSelectMode: (value: AgentMode) => void;
  activeWorkspaceId: string | null;
  worktrees: WorktreeListItem[];
  activeWorktreeId?: string | null;
  worktreeEnvironment: WorktreeDraftEnvironment;
  worktreeMutationPending?: boolean;
  worktreeMutationError?: Error | null;
  onSelectWorktreeEnvironment: (environment: WorktreeDraftEnvironment) => void;
  /** Opens the folder picker from a composer the user can't type in. */
  onAddWorkspace: () => void;
  onModelsRefreshed?: () => void;
  hasConversation?: boolean;
  workspaceRoot: string | null;
  agentStatus: AgentStatus;
  pendingPermission?: PendingPermissionInfo | null;
  onModeChange?: (mode: AgentMode) => void;
  todos?: TodoState;
  tasksTurnId?: string | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * OS file paths from a native drop, via webUtils.getPathForFile: File.path was
 * removed in Electron 32+ with contextIsolation.
 */
export const resolveDroppedOsFiles = (
  dt: DataTransfer
): Array<{ file: File; absPath: string; isDirectory: boolean }> => {
  const files = Array.from(dt.files);
  const items = Array.from(dt.items);
  return files.map((file, i) => {
    const entry = items[i]?.webkitGetAsEntry?.();
    const absPath = window.api.getPathForFile(file) || file.name;
    return { file, absPath, isDirectory: entry?.isDirectory === true };
  });
};

const toAttachment = (
  file: File,
  path: string | null = null
): LocalAttachment => ({
  id: crypto.randomUUID(),
  name: file.name,
  size: file.size,
  mimeType: file.type,
  file,
  previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
  path,
});

const formatBytes = (v: number): string => {
  if (v < 1024) return `${v} B`;
  const kb = v / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
};

// ─── PR status pill ───────────────────────────────────────────────────────────
// The trigger opens the PR; hover adds context without nesting controls.

const PR_STATE_COLOR: Record<PrReviewState, string> = {
  approved: "text-green-400",
  pending: "text-amber-400",
  changes_requested: "text-red-400",
  draft: "text-muted-foreground",
  merged: "text-primary",
  closed: "text-muted-foreground",
};

const CI_COLOR: Record<NonNullable<PrInfo["ciStatus"]>, string> = {
  success: "text-green-400",
  failure: "text-red-400",
  pending: "text-amber-400",
};

const CiIcon = ({
  status,
}: {
  status: NonNullable<PrInfo["ciStatus"]>;
}): JSX.Element => {
  if (status === "pending") {
    return <Spinner fontSize={12} className="text-current" />;
  }
  const StatusIcon = status === "success" ? CircleCheck : CircleX;
  return <StatusIcon className="size-3" />;
};

export const PrStatusPill = ({
  pr,
  branch,
}: {
  pr: PrInfo;
  branch?: string | null;
}): JSX.Element => {
  const { t } = useTranslation();
  const openPr = (): void => {
    void window.api.openExternal(pr.url);
  };

  const passed = pr.checks.filter((c) => c.status === "success").length;
  const failed = pr.checks.filter((c) => c.status === "failure").length;
  const running = pr.checks.filter((c) => c.status === "pending").length;

  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            data-id="local-code-pr-status"
            aria-label={t("workspace.prStatus.open", { number: pr.number })}
            onClick={openPr}
            className="max-w-48 min-w-0"
          />
        }
      >
        <span
          className={`text-[0.625rem] leading-none ${PR_STATE_COLOR[pr.reviewState]}`}
        >
          ●
        </span>
        <span className={`font-medium ${PR_STATE_COLOR[pr.reviewState]}`}>
          {t("workspace.prStatus.label", { number: pr.number })}
        </span>
        {pr.ciStatus != null && (
          <span className={CI_COLOR[pr.ciStatus]}>
            <CiIcon status={pr.ciStatus} />
          </span>
        )}
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="end"
        sideOffset={6}
        className="w-80 max-w-[calc(100vw-1rem)] space-y-3"
      >
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-3">
            <span className={`font-medium ${PR_STATE_COLOR[pr.reviewState]}`}>
              {t("workspace.prStatus.label", { number: pr.number })}
            </span>
            <span className="text-muted-foreground">
              {t(`workspace.prStatus.${pr.reviewState}`)}
            </span>
          </div>
          {pr.title !== "" && (
            <p className="line-clamp-2 text-sm leading-snug font-medium">
              {pr.title}
            </p>
          )}
        </div>

        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
          {branch != null && branch !== "" && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <GitBranch className="size-3" />
              <span className="max-w-40 truncate">{branch}</span>
            </span>
          )}
          <span>
            <span className="text-green-400">+{pr.additions}</span>{" "}
            <span className="text-red-400">−{pr.deletions}</span>
          </span>
        </div>

        <div className="text-muted-foreground">
          {t("workspace.prStatus.reviews", {
            approved: pr.approvedCount,
            changes: pr.changesRequestedCount,
            requested: pr.reviewRequestedCount,
          })}
        </div>

        {pr.checks.length > 0 && (
          <div className="border-border space-y-1.5 border-t pt-2">
            <div className="text-muted-foreground flex items-center gap-1.5">
              {pr.ciStatus != null && (
                <span className={CI_COLOR[pr.ciStatus]}>
                  <CiIcon status={pr.ciStatus} />
                </span>
              )}
              <span className="flex-1">
                {t("workspace.prStatus.checksSummary", {
                  passed,
                  failed,
                  running,
                })}
              </span>
            </div>
            <div className="max-h-36 space-y-1 overflow-y-auto">
              {pr.checks.map((check, index) => (
                <div
                  key={`${check.name}-${index}`}
                  className="flex min-w-0 items-center gap-2"
                >
                  <span className={CI_COLOR[check.status]}>
                    <CiIcon status={check.status} />
                  </span>
                  <span className="text-muted-foreground truncate">
                    {check.name}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        <Button
          variant="secondary"
          size="sm"
          onClick={openPr}
          className="w-full"
        >
          <ExternalLink />
          {t("workspace.prStatus.openAction")}
        </Button>
      </HoverCardContent>
    </HoverCard>
  );
};

// ─── Permission pane ──────────────────────────────────────────────────────────

type PermissionDecisionInput = PermissionDecision;

const getProp = <T,>(
  input: Record<string, unknown>,
  key: string
): T | undefined => (input[key] as T) ?? undefined;

/** The growth and the box's own max-height have to agree; one name for both. */
const COMPOSER_MAX_HEIGHT = 200;

function PermActionList({
  onDecide,
  allowLabel = "Allow once",
  showAllowAlways = false,
  alwaysAllowLabel = "Always accept edits this session",
  alwaysAllowRule,
  alwaysAllowRules,
  showAllowYolo = false,
}: {
  onDecide: (d: PermissionDecisionInput) => void;
  allowLabel?: string;
  showAllowAlways?: boolean;
  alwaysAllowLabel?: string;
  alwaysAllowRule?: string | null;
  alwaysAllowRules?: string[] | null;
  showAllowYolo?: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<"allow" | "deny" | null>(null);
  const [msg, setMsg] = useState("");

  const submitExpanded = (type: "allow" | "deny"): void => {
    if (type === "allow") {
      onDecide(
        msg.trim() ? { type: "accept_with_message", message: msg } : "accept"
      );
    } else {
      onDecide(
        msg.trim() ? { type: "reject_with_message", message: msg } : "reject"
      );
    }
    setExpanded(null);
    setMsg("");
  };

  const cancel = (): void => {
    setExpanded(null);
    setMsg("");
  };

  // Permission rows grow to fill the row, left-aligned, wrapping long labels.
  const rowBtn = "flex-1 justify-start whitespace-normal";

  const multipleRules =
    alwaysAllowRules && alwaysAllowRules.length > 1 ? alwaysAllowRules : null;

  return (
    <div className="flex flex-col gap-1">
      {/* Allow row */}
      {expanded === "allow" ? (
        <div className="flex flex-col gap-1">
          <Textarea
            rows={2}
            placeholder={t("workspace.perm.optionalContext")}
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitExpanded("allow");
              }
              if (e.key === "Escape") cancel();
            }}
            autoFocus
          />
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" size="xs" onClick={cancel}>
              Cancel
            </Button>
            <Button size="xs" onClick={() => submitExpanded("allow")}>
              Allow
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            data-id="local-code-perm-allow-btn"
            onClick={() => onDecide("accept")}
            className={rowBtn}
          >
            <Check />
            {allowLabel}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title={t("workspace.perm.allowWithContext")}
            onClick={() => {
              setExpanded("allow");
              setMsg("");
            }}
          >
            …
          </Button>
        </div>
      )}

      {/* Always allow with single rule */}
      {alwaysAllowRule != null && multipleRules == null && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            onDecide({
              type: "allow_always_with_rules",
              rules: [alwaysAllowRule],
            })
          }
          className={rowBtn}
        >
          <CircleCheck className="shrink-0 text-green-400" />
          Always allow {alwaysAllowRule}
        </Button>
      )}

      {/* Always allow all rules (compound bash) */}
      {multipleRules != null && (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              onDecide({
                type: "allow_always_with_rules",
                rules: multipleRules.map((r) => `Bash(${r})`),
              })
            }
            className={rowBtn}
          >
            <CircleCheck className="shrink-0 text-green-400" />
            Always allow all:{" "}
            {multipleRules.map((r) => `Bash(${r})`).join(", ")}
          </Button>
          {multipleRules.map((rule) => (
            <Button
              key={rule}
              variant="ghost"
              size="sm"
              onClick={() =>
                onDecide({
                  type: "allow_always_with_rules",
                  rules: [`Bash(${rule})`],
                })
              }
              className={rowBtn}
            >
              <CircleCheck className="shrink-0 text-green-400" />
              Always allow Bash({rule})
            </Button>
          ))}
        </>
      )}

      {/* Always accept this session (mode switch → acceptEdits) */}
      {showAllowAlways && (
        <Button
          variant="ghost"
          size="sm"
          data-id="local-code-perm-allow-always-btn"
          onClick={() => onDecide("allowAlways")}
          className={rowBtn}
        >
          <CircleCheck className="shrink-0 text-green-400" />
          {alwaysAllowLabel}
        </Button>
      )}

      {/* Bypass all permissions (mode switch → yolo) */}
      {showAllowYolo && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDecide("allowYolo")}
          className={rowBtn}
        >
          <CircleCheck className="shrink-0 text-orange-400" />
          Yes, implement (full permissions granted)
        </Button>
      )}

      {/* Deny row */}
      {expanded === "deny" ? (
        <div className="flex flex-col gap-1">
          <Textarea
            className="focus:border-red-400/50"
            rows={2}
            placeholder={t("workspace.perm.denyReason")}
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submitExpanded("deny");
              }
              if (e.key === "Escape") cancel();
            }}
            autoFocus
          />
          <div className="flex items-center justify-end gap-1">
            <Button variant="ghost" size="xs" onClick={cancel}>
              Cancel
            </Button>
            <Button
              variant="outline"
              size="xs"
              onClick={() => submitExpanded("deny")}
              className="hover:border-red-400/30 hover:text-red-400"
            >
              Deny
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            data-id="local-code-perm-deny-btn"
            onClick={() => onDecide("reject")}
            className={`${rowBtn} hover:border-red-400/30 hover:text-red-400`}
          >
            <X />
            Deny
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title={t("workspace.perm.denyWithReason")}
            onClick={() => {
              setExpanded("deny");
              setMsg("");
            }}
          >
            …
          </Button>
        </div>
      )}
    </div>
  );
}

// Tool-specific permission sub-components

function BashPermissionUI({
  tool,
  onDecide,
}: {
  tool: PendingPermissionInfo;
  onDecide: (d: PermissionDecisionInput) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const command = String(tool.toolInput.command ?? "").trim();
  const displayName = getProp<string>(tool.toolInput, "_displayName") ?? "Bash";
  const credentialPaths =
    tool.request?.type === "run_terminal"
      ? (tool.request.credentialPaths ?? [])
      : [];
  const alwaysAllowRule =
    getProp<string>(tool.toolInput, "_alwaysAllowRule") ?? null;
  const alwaysAllowRules =
    getProp<string[]>(tool.toolInput, "_alwaysAllowRules") ?? null;
  const fallbackRule =
    !alwaysAllowRule && (!alwaysAllowRules || alwaysAllowRules.length === 0)
      ? `Bash(${command.slice(0, 120)}${command.length > 120 ? "…" : ""})`
      : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
        <span className="text-foreground text-xs font-medium">
          Run {displayName} command?
        </span>
      </div>
      {command.length > 0 && (
        <pre className="text-muted-foreground bg-muted border-border max-h-20 overflow-y-auto rounded-lg border px-2.5 py-2 font-mono text-xs break-all whitespace-pre-wrap">
          {command}
        </pre>
      )}
      {credentialPaths.length > 0 && (
        <div
          className="flex flex-col gap-1 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-2 text-xs"
          data-id="permission-credential-read"
        >
          <span className="text-foreground font-medium">
            {t("permissions.credentialRead")}
          </span>
          <ul className="text-muted-foreground list-disc pl-4 font-mono break-all">
            {credentialPaths.map((store) => (
              <li key={store}>{store}</li>
            ))}
          </ul>
          <span className="text-muted-foreground">
            {t("permissions.credentialAlways")}
          </span>
        </div>
      )}
      <PermActionList
        onDecide={onDecide}
        alwaysAllowRule={alwaysAllowRule ?? fallbackRule}
        alwaysAllowRules={alwaysAllowRules}
      />
    </div>
  );
}

/** The sandbox refused what a command tried; allowing runs the command again. */
function SandboxDeniedPermissionUI({
  tool,
  onDecide,
}: {
  tool: PendingPermissionInfo;
  onDecide: (d: PermissionDecisionInput) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const request = tool.request?.type === "sandbox_denied" ? tool.request : null;
  const command = request?.command ?? "";
  const denials = request?.denials ?? [];
  return (
    <div className="flex flex-col gap-2" data-id="permission-sandbox-denied">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
        <span className="text-foreground text-xs font-medium">
          {t("permissions.sandboxDenied")}
        </span>
      </div>
      {command.length > 0 && (
        <pre className="text-muted-foreground bg-muted border-border max-h-20 overflow-y-auto rounded-lg border px-2.5 py-2 font-mono text-xs break-all whitespace-pre-wrap">
          {command}
        </pre>
      )}
      <ul className="text-muted-foreground list-disc pl-4 font-mono text-xs break-all">
        {denials.map((denial) => (
          <li key={JSON.stringify(denial)}>
            {denial.kind === "host"
              ? t("permissions.sandboxDeniedHost", {
                  host: `${denial.host}:${denial.port}`,
                })
              : denial.kind === "read"
                ? t("permissions.sandboxDeniedRead", { path: denial.path })
                : t("permissions.sandboxDeniedWrite", { path: denial.path })}
          </li>
        ))}
      </ul>
      {request?.note != null && request.note.length > 0 && (
        <span
          className="text-xs text-amber-600 dark:text-amber-400"
          data-id="permission-sandbox-denied-note"
        >
          {request.note}
        </span>
      )}
      <span className="text-muted-foreground text-xs">
        {t("permissions.sandboxDeniedRerun")}
      </span>
      <PermActionList
        onDecide={onDecide}
        showAllowAlways={true}
        alwaysAllowLabel={t("permissions.sandboxDeniedAlways")}
      />
    </div>
  );
}

/** A sandboxed command reached for a host nobody listed; it waits on this. */
function NetworkHostPermissionUI({
  tool,
  onDecide,
}: {
  tool: PendingPermissionInfo;
  onDecide: (d: PermissionDecisionInput) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const request = tool.request?.type === "network_host" ? tool.request : null;
  const host = request?.host ?? getProp<string>(tool.toolInput, "host") ?? "";
  const port = request?.port ?? getProp<number>(tool.toolInput, "port") ?? 0;
  return (
    <div className="flex flex-col gap-2" data-id="permission-network-host">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
        <span className="text-foreground text-xs font-medium">
          {t("permissions.networkHost")}
        </span>
      </div>
      <pre className="text-muted-foreground bg-muted border-border rounded-lg border px-2.5 py-2 font-mono text-xs break-all whitespace-pre-wrap">
        {host}:{port}
      </pre>
      <PermActionList
        onDecide={onDecide}
        showAllowAlways={true}
        alwaysAllowLabel={t("permissions.networkHostAlways", { host })}
      />
    </div>
  );
}

function EditFilePermissionUI({
  tool,
  onDecide,
}: {
  tool: PendingPermissionInfo;
  onDecide: (d: PermissionDecisionInput) => void;
}): JSX.Element {
  // Tool inputs spell the target file several ways depending on the tool.
  const file =
    getProp<string>(tool.toolInput, "file_path") ??
    getProp<string>(tool.toolInput, "filePath") ??
    getProp<string>(tool.toolInput, "notebookPath") ??
    getProp<string>(tool.toolInput, "path") ??
    "";
  const short = file.length > 50 ? `…${file.slice(-50)}` : file;
  const displayName = getProp<string>(tool.toolInput, "_displayName") ?? "Edit";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
        <span className="text-foreground text-xs font-medium">
          {displayName} file?
        </span>
      </div>
      {short.length > 0 && (
        <pre className="text-muted-foreground bg-muted border-border max-h-20 overflow-y-auto rounded-lg border px-2.5 py-2 font-mono text-xs break-all whitespace-pre-wrap">
          {short}
        </pre>
      )}
      <PermActionList
        onDecide={onDecide}
        showAllowAlways={true}
        alwaysAllowLabel="Always accept edits this session"
      />
    </div>
  );
}

function OutsideDirPermissionUI({
  tool,
  onDecide,
  verb,
}: {
  tool: PendingPermissionInfo;
  onDecide: (d: PermissionDecisionInput) => void;
  verb: string;
}): JSX.Element {
  const req = tool.request;
  const outsideDir =
    req?.type === "write_outside_directory" ||
    req?.type === "edit_outside_directory"
      ? req
      : undefined;
  const file =
    outsideDir?.filePath ??
    getProp<string>(tool.toolInput, "file_path") ??
    getProp<string>(tool.toolInput, "filePath") ??
    getProp<string>(tool.toolInput, "path") ??
    "";
  const short = file.length > 50 ? `…${file.slice(-50)}` : file;
  const deducedDir =
    outsideDir?.deducedDirectory ??
    getProp<string>(tool.toolInput, "_deducedDirectory") ??
    "";
  const isNewFile =
    (outsideDir?.type === "write_outside_directory"
      ? outsideDir.isNewFile
      : undefined) ??
    getProp<boolean>(tool.toolInput, "_isNewFile") ??
    false;
  const question =
    verb === "read"
      ? "Read file outside workspace?"
      : isNewFile
        ? "Create file outside workspace?"
        : `${verb.charAt(0).toUpperCase() + verb.slice(1)} file outside workspace?`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
        <span className="text-foreground text-xs font-medium">{question}</span>
      </div>
      {short.length > 0 && (
        <code className="text-muted-foreground bg-muted border-border self-start rounded border px-2 py-0.5 font-mono text-xs break-all">
          {short}
        </code>
      )}
      {deducedDir.length > 0 && (
        <p className="text-muted-foreground text-xs">Directory: {deducedDir}</p>
      )}
      <PermActionList
        onDecide={onDecide}
        allowLabel={
          verb === "read"
            ? "Allow read once"
            : isNewFile
              ? "Create once"
              : `Allow ${verb} once`
        }
        showAllowAlways={deducedDir.length > 0}
        // A read allowance is a full allow; a write allowance only answers "may
        // it go outside the workspace", after which the mode decides as for any file.
        alwaysAllowLabel={
          deducedDir.length === 0
            ? undefined
            : verb === "read"
              ? `Always allow ${deducedDir}`
              : `Treat ${deducedDir} as part of the workspace`
        }
      />
    </div>
  );
}

function ExitPlanModePermissionUI({
  tool,
  onDecide,
}: {
  tool: PendingPermissionInfo;
  onDecide: (d: PermissionDecisionInput) => void;
}): JSX.Element {
  const { t } = useTranslation();
  // The typed request first: `_planContent` is the legacy protocol's synthetic
  // arg, and reading only that showed the buttons with no plan above them.
  const request = tool.request?.type === "exit_plan_mode" ? tool.request : null;
  const planFilePath =
    request?.planFilePath ??
    getProp<string>(tool.toolInput, "planFilePath") ??
    "";
  const short =
    planFilePath.length > 60 ? `…${planFilePath.slice(-60)}` : planFilePath;
  const planContent =
    request?.planContent ??
    getProp<string>(tool.toolInput, "_planContent") ??
    getProp<string>(tool.toolInput, "plan") ??
    "";
  // Unlike PermActionList's rows, these buttons don't grow (no flex-1).
  const rowBtn = "justify-start whitespace-normal";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
        <span className="text-foreground text-xs font-medium">
          {t("workspace.perm.readyToImplement")}
        </span>
      </div>
      {short.length > 0 && (
        <code className="text-muted-foreground bg-muted border-border self-start rounded border px-2 py-0.5 font-mono text-xs break-all">
          {short}
        </code>
      )}
      {planContent.length > 0 && (
        <div className="border-border text-muted-foreground max-h-48 overflow-y-auto rounded-lg border px-2.5 py-2 text-xs whitespace-pre-wrap">
          {planContent}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDecide("accept")}
          className={rowBtn}
        >
          <Check /> Yes, implement (approve each edit)
        </Button>
        <Button
          size="sm"
          data-id="local-code-perm-allow-btn"
          onClick={() => onDecide("allowAlways")}
          className={rowBtn}
        >
          <Check /> Yes, implement (auto-accept all edits)
        </Button>
        <Button
          size="sm"
          onClick={() => onDecide("allowYolo")}
          className={rowBtn}
        >
          <Check /> Yes, implement (full permissions granted)
        </Button>
        <Button
          variant="outline"
          size="sm"
          data-id="local-code-perm-deny-btn"
          onClick={() => onDecide("reject")}
          className={`${rowBtn} hover:border-red-400/30 hover:text-red-400`}
        >
          <X /> No, keep planning
        </Button>
      </div>
    </div>
  );
}

function AskUserQuestionPermissionUI({
  tool,
  onDecide,
}: {
  tool: PendingPermissionInfo;
  onDecide: (d: PermissionDecisionInput) => void;
}): JSX.Element {
  interface QuestionItem {
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }
  const { t } = useTranslation();
  const questions = (
    getProp<QuestionItem[]>(tool.toolInput, "questions") ?? []
  ).filter((q) => q?.options?.length > 0);
  const [qIdx, setQIdx] = useState(0);
  const [selected, setSelected] = useState<Map<number, Set<number>>>(
    () => new Map()
  );
  const [noteMode, setNoteMode] = useState(false);
  const [notes, setNotes] = useState<Map<number, string>>(() => new Map());
  const [noteText, setNoteText] = useState("");

  const current = questions[qIdx];
  const currentSel = selected.get(qIdx) ?? new Set<number>();

  const buildAnswers = (
    finalSel: Map<number, Set<number>>,
    finalNotes: Map<number, string>
  ): Record<string, string> => {
    const answers: Record<string, string> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i]!;
      const sel = finalSel.get(i);
      if (!sel || sel.size === 0) continue;
      const chosen = [...sel]
        .sort((a, b) => a - b)
        .map((idx) => q.options[idx]?.label ?? "")
        .filter(Boolean);
      const note = finalNotes.get(i);
      answers[`question_${i}`] = note
        ? `${chosen.join(", ")} — ${note}`
        : chosen.join(", ");
    }
    return answers;
  };

  const submit = (
    finalSel: Map<number, Set<number>>,
    finalNotes: Map<number, string>
  ) => {
    onDecide({
      type: "question_answers",
      answers: buildAnswers(finalSel, finalNotes),
    });
  };

  const toggleOption = (optIdx: number) => {
    const newSel = new Map(selected);
    const s = new Set(currentSel);
    if (current?.multiSelect) {
      if (s.has(optIdx)) s.delete(optIdx);
      else s.add(optIdx);
    } else {
      s.clear();
      s.add(optIdx);
    }
    newSel.set(qIdx, s);
    setSelected(newSel);
  };

  const goNext = () => {
    if (qIdx < questions.length - 1) {
      setQIdx(qIdx + 1);
      setNoteMode(false);
      setNoteText("");
    } else submit(selected, notes);
  };

  const saveNote = () => {
    const newNotes = new Map(notes);
    const trimmed = noteText.trim();
    if (trimmed) newNotes.set(qIdx, trimmed);
    else newNotes.delete(qIdx);
    setNotes(newNotes);
    setNoteMode(false);
    setNoteText("");
  };

  // Same non-growing row treatment as ExitPlanModePermissionUI.
  const rowBtn = "justify-start whitespace-normal";

  if (!current) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-cyan-400" />
          <span className="text-foreground text-xs font-medium">
            {t("workspace.perm.noQuestions")}
          </span>
        </div>
        <Button
          size="sm"
          onClick={() => submit(selected, notes)}
          className={rowBtn}
        >
          <Check /> Continue
        </Button>
      </div>
    );
  }

  const currentNote = notes.get(qIdx);

  return (
    <div className="flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-cyan-400" />
        <span className="text-foreground text-xs font-medium">
          {questions.length > 1 && (
            <span className="text-muted-foreground mr-1 text-xs">
              ({qIdx + 1}/{questions.length})
            </span>
          )}
          {current.header}
        </span>
      </div>
      {/* Question text */}
      <p className="text-secondary-foreground text-xs leading-relaxed">
        {current.question}
      </p>
      {/* Options */}
      <div className="flex flex-col gap-0.5">
        {current.options.map((opt, idx) => {
          const isSel = currentSel.has(idx);
          return (
            <Button
              key={idx}
              variant={isSel ? "secondary" : "ghost"}
              size="sm"
              onClick={() => toggleOption(idx)}
              aria-pressed={isSel}
              className="h-auto items-start justify-start gap-2 px-2 py-1.5 text-left whitespace-normal"
            >
              <span
                className={`mt-px shrink-0 text-xs ${isSel ? "text-green-400" : "text-muted-foreground"}`}
              >
                {current.multiSelect ? (isSel ? "■" : "□") : isSel ? "●" : "○"}
              </span>
              <span className="flex min-w-0 flex-col">
                <span
                  className={`font-medium ${isSel ? "text-foreground" : ""}`}
                >
                  {opt.label}
                </span>
                {opt.description && (
                  <span className="text-muted-foreground mt-0.5 text-xs leading-snug">
                    {opt.description}
                  </span>
                )}
              </span>
            </Button>
          );
        })}
      </div>
      {/* Note */}
      {noteMode ? (
        <div className="flex flex-col gap-1">
          <Textarea
            rows={2}
            placeholder={t("workspace.perm.addContext")}
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                saveNote();
              }
              if (e.key === "Escape") {
                setNoteMode(false);
                setNoteText("");
              }
            }}
            autoFocus
          />
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setNoteMode(false);
                setNoteText("");
              }}
            >
              Cancel
            </Button>
            <Button size="xs" onClick={saveNote}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        currentNote && (
          <p className="text-muted-foreground text-xs">
            Note: <span className="italic">{currentNote}</span>
          </p>
        )
      )}
      {/* Actions */}
      <div className="border-border flex items-center gap-1 border-t pt-2">
        {qIdx > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQIdx(qIdx - 1);
              setNoteMode(false);
              setNoteText("");
            }}
            className={rowBtn}
          >
            ‹ Back
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setNoteText(currentNote ?? "");
            setNoteMode(true);
          }}
          className={rowBtn}
        >
          {currentNote ? "Edit note" : "+ Note"}
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => submit(selected, notes)}
          className={rowBtn}
        >
          Skip
        </Button>
        <Button
          size="sm"
          data-id="local-code-question-submit-btn"
          onClick={goNext}
          className={rowBtn}
        >
          <Check />
          {qIdx < questions.length - 1 ? "Next ›" : "Submit"}
        </Button>
      </div>
    </div>
  );
}

function GenericPermissionUI({
  tool,
  onDecide,
}: {
  tool: PendingPermissionInfo;
  onDecide: (d: PermissionDecisionInput) => void;
}): JSX.Element {
  const displayName =
    getProp<string>(tool.toolInput, "_displayName") ??
    (typeof tool.toolName === "string" ? tool.toolName.replace(/_/g, " ") : "");
  const alwaysAllowRule =
    getProp<string>(tool.toolInput, "_alwaysAllowRule") ?? null;
  const firstVal = Object.entries(tool.toolInput)
    .filter(([k]) => !k.startsWith("_"))
    .map(([, v]) =>
      typeof v === "string"
        ? v
        : typeof v === "object" && v != null
          ? JSON.stringify(v)
          : null
    )
    .find((v) => v != null);
  const preview = firstVal != null ? firstVal.slice(0, 200) : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
        <span className="text-foreground text-xs font-medium">
          Allow <strong>{displayName}</strong>?
        </span>
      </div>
      {preview != null && (
        <pre className="text-muted-foreground bg-muted border-border max-h-20 overflow-y-auto rounded-lg border px-2.5 py-2 font-mono text-xs break-all whitespace-pre-wrap">
          {preview}
        </pre>
      )}
      <PermActionList onDecide={onDecide} alwaysAllowRule={alwaysAllowRule} />
    </div>
  );
}

const BROWSER_ACTION_DESCRIPTIONS: Record<string, Record<string, string>> = {
  browser_interact: {
    click: "Click an element on the page",
    fill: "Clear and type into an input field",
    type: "Type text into an input field",
    scroll: "Scroll the page",
    scroll_into_view: "Scroll an element into view",
    select: "Select a dropdown option",
    hover: "Hover over an element",
    focus: "Focus an element",
    check: "Check a checkbox",
    uncheck: "Uncheck a checkbox",
    press: "Press a keyboard key",
    wait: "Wait for a page condition",
  },
  browser_execute: {
    _default: "Execute JavaScript on the page",
  },
};

function BrowserPermissionUI({
  tool,
  onDecide,
}: {
  tool: PendingPermissionInfo;
  onDecide: (d: PermissionDecisionInput) => void;
}): JSX.Element {
  const action = String(tool.toolInput.action ?? "").trim();
  const isBrowserInteract = tool.toolName === "browser_interact";
  const Icon = isBrowserInteract ? MousePointer2 : Code;
  const iconColor = isBrowserInteract ? "text-orange-400" : "text-emerald-400";

  const description = isBrowserInteract
    ? (BROWSER_ACTION_DESCRIPTIONS.browser_interact[action] ??
      `Browser ${action}`)
    : BROWSER_ACTION_DESCRIPTIONS.browser_execute._default;

  const details: Array<[string, string, boolean?]> = [];
  if (isBrowserInteract && action) details.push(["Action", action]);
  const ref = tool.toolInput.ref as string | undefined;
  if (ref) details.push(["Ref", ref, true]);
  if (tool.toolInput.selector)
    details.push(["Selector", String(tool.toolInput.selector)]);
  if (tool.toolInput.text) details.push(["Text", String(tool.toolInput.text)]);
  if (tool.toolInput.value)
    details.push(["Value", String(tool.toolInput.value)]);
  if (tool.toolInput.key) details.push(["Key", String(tool.toolInput.key)]);
  if (tool.toolInput.code)
    details.push(["Code", String(tool.toolInput.code).slice(0, 200)]);
  if (tool.toolInput.direction)
    details.push(["Direction", String(tool.toolInput.direction)]);
  if (tool.toolInput.amount != null)
    details.push(["Amount", String(tool.toolInput.amount)]);
  if (tool.toolInput.url_pattern)
    details.push(["URL Pattern", String(tool.toolInput.url_pattern)]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <Icon className={`${iconColor} mt-0.5 size-3.5 shrink-0`} />
        <span className="text-foreground text-xs font-medium">
          {description}?
        </span>
      </div>
      {details.length > 0 && (
        <div className="bg-muted border-border flex max-h-30 flex-col gap-1 overflow-y-auto rounded-lg border px-2.5 py-2">
          {details.map(([label, value, highlighted]) => (
            <div key={label} className="flex gap-2 text-xs">
              <span className="text-muted-foreground w-16 shrink-0">
                {label}
              </span>
              <span
                className={`font-mono break-all ${highlighted ? "text-foreground font-medium" : "text-secondary-foreground"}`}
              >
                {value}
              </span>
            </div>
          ))}
        </div>
      )}
      <PermActionList onDecide={onDecide} allowLabel="Allow once" />
    </div>
  );
}

const PermissionPane = ({
  permission,
  onModeChange,
}: {
  permission: PendingPermissionInfo | null | undefined;
  onModeChange?: (mode: AgentMode) => void;
}): JSX.Element | null => {
  if (permission == null) return null;

  const decide = (decision: PermissionDecisionInput): void => {
    // If decision triggers a mode change, update the local UI too
    if (decision === "allowAlways" && onModeChange != null)
      onModeChange(AgentMode.AcceptEdits);
    if (decision === "allowYolo" && onModeChange != null)
      onModeChange(AgentMode.Yolo);
    // The transport owns the toolCallId -> permissionId join and retires the
    // prompt as soon as the decision is sent, so the pane closes on click.
    void workspaceConversationTransport.respondToPermission(
      permission.sessionId,
      permission.permissionId,
      decision
    );
  };

  // `request.type` is authoritative; legacy `_permissionType` is only a fallback.
  const permissionType =
    permission.request?.type ??
    getProp<string>(permission.toolInput, "_permissionType");
  const toolName = permission.toolName.toLowerCase();

  let content: JSX.Element;
  if (permissionType === "write_outside_directory") {
    content = (
      <OutsideDirPermissionUI
        tool={permission}
        onDecide={decide}
        verb="write"
      />
    );
  } else if (
    permissionType === "edit_outside_directory" ||
    permissionType === "notebook_edit_outside_directory"
  ) {
    content = (
      <OutsideDirPermissionUI tool={permission} onDecide={decide} verb="edit" />
    );
  } else if (
    permissionType === "read_outside_directory" ||
    getProp<string>(permission.toolInput, "_deducedDirectory") != null
  ) {
    content = (
      <OutsideDirPermissionUI tool={permission} onDecide={decide} verb="read" />
    );
  } else if (permissionType === "network_host") {
    content = <NetworkHostPermissionUI tool={permission} onDecide={decide} />;
  } else if (permissionType === "sandbox_denied") {
    content = <SandboxDeniedPermissionUI tool={permission} onDecide={decide} />;
  } else if (permissionType === "exit_plan_mode") {
    content = <ExitPlanModePermissionUI tool={permission} onDecide={decide} />;
  } else if (permissionType === "ask_user_question") {
    content = (
      <AskUserQuestionPermissionUI tool={permission} onDecide={decide} />
    );
  } else if (toolName === "bash") {
    content = <BashPermissionUI tool={permission} onDecide={decide} />;
  } else if (
    toolName === "edit" ||
    toolName === "batch_edit" ||
    toolName === "multiedit" ||
    toolName === "write" ||
    toolName === "notebook_edit"
  ) {
    content = <EditFilePermissionUI tool={permission} onDecide={decide} />;
  } else if (toolName === "exit_plan_mode") {
    content = <ExitPlanModePermissionUI tool={permission} onDecide={decide} />;
  } else if (toolName === "ask_user_question") {
    content = (
      <AskUserQuestionPermissionUI tool={permission} onDecide={decide} />
    );
  } else if (
    toolName === "browser_interact" ||
    toolName === "browser_execute"
  ) {
    content = <BrowserPermissionUI tool={permission} onDecide={decide} />;
  } else {
    content = <GenericPermissionUI tool={permission} onDecide={decide} />;
  }

  return (
    <div
      className="flex flex-col gap-2 px-4 pt-3 pb-3"
      data-id="local-code-permission-pane"
    >
      {content}
    </div>
  );
};

// ─── Attach menu ──────────────────────────────────────────────────────────────

type AttachMenuAction = "files" | "folder";

/**
 * The paperclip's menu: files staged as attachments, or a folder referenced
 * as an @-mention. Pasting, dropping and typing cover everything else.
 */
const AttachMenu = ({
  onAction,
  /** A + in the compact composer, where it opens the row like a message app. */
  asPlus = false,
  buttonClassName,
}: {
  onAction: (action: AttachMenuAction) => void;
  asPlus?: boolean;
  buttonClassName?: string;
}): JSX.Element => {
  const { t } = useTranslation();
  const items: Array<{ id: AttachMenuAction; icon: ReactNode; label: string }> =
    [
      {
        id: "files",
        icon: <FileText />,
        label: t("workspace.attach.files"),
      },
      {
        id: "folder",
        icon: <Folder />,
        label: t("workspace.attach.folder"),
      },
    ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            data-id="local-code-attachment-btn"
            aria-label={t("workspace.attach.menuLabel")}
            className={buttonClassName}
          />
        }
      >
        {asPlus ? <Plus /> : <Paperclip />}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-56"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {t("workspace.attach.menuLabel")}
          </DropdownMenuLabel>
          {items.map((item) => (
            <DropdownMenuItem
              key={item.id}
              data-id={`local-code-attach-${item.id}`}
              onClick={() => onAction(item.id)}
            >
              <span className="text-muted-foreground">{item.icon}</span>
              <span>{item.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="max-w-56 whitespace-normal normal-case">
            {t("workspace.attach.mentionTip")}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

// ─── Attachment strip ─────────────────────────────────────────────────────────

const AttachmentStrip = ({
  attachments,
  onRemove,
}: {
  attachments: LocalAttachment[];
  onRemove: (id: string) => void;
}): JSX.Element | null => {
  if (attachments.length === 0) return null;
  return (
    <div className="border-text-primary/10 max-h-28 overflow-auto border-b px-3 py-2">
      <div className="flex flex-wrap gap-2">
        {attachments.map((a) => (
          <div
            key={a.id}
            data-id={`local-code-attachment-${a.id}`}
            className="border-text-primary/10 flex items-center gap-2 rounded-lg border bg-black/15 px-2 py-1"
          >
            {a.previewUrl == null ? (
              <FileText className="text-muted-foreground size-3.5 shrink-0" />
            ) : (
              <img
                src={a.previewUrl}
                alt={a.name}
                className="h-7 w-7 shrink-0 rounded object-cover"
              />
            )}
            <div className="min-w-0">
              <div className="text-foreground max-w-44 truncate text-xs">
                {a.name}
              </div>
              <div className="text-muted-foreground text-[0.625rem]">
                {formatBytes(a.size)}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onRemove(a.id)}
              data-id={`local-code-attachment-remove-${a.id}`}
            >
              <X />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── Highlight overlay ──────────────────────────────────────────────────────
// Sits behind the transparent textarea and colours @mentions and /commands.
// Font, padding and line-height MUST match the textarea or the caret drifts.

const HighlightOverlay = ({
  value,
  placeholder,
  overlayInnerRef,
  compact = false,
}: {
  value: string;
  placeholder?: string;
  overlayInnerRef: RefObject<HTMLDivElement | null>;
  /** Must track the textarea's own compact padding — see the note above. */
  compact?: boolean;
}): JSX.Element => {
  const tokens = tokenize(value);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl">
      <div
        ref={overlayInnerRef}
        aria-hidden
        // `pe-12` matches the textarea, which reserves that strip for the send
        // button and so wraps a long line earlier than a `px-3.5` overlay
        // would; any width the two do not share is caret drift.
        className={`text-foreground w-full ps-3.5 pe-12 break-words whitespace-pre-wrap ${compact ? "py-2" : "pt-3 pb-2"}`}
        style={{
          // Byte-for-byte the textarea's metrics; drift slides the caret off its glyph.
          fontSize: "14px",
          lineHeight: 1.5,
          // The overlay is many spans, the textarea one run; kerning and
          // ligatures apply per run, so both sides disable them or the caret drifts.
          fontKerning: "none",
          fontVariantLigatures: "none",
        }}
      >
        {/* Native ::placeholder is invisible under WebkitTextFillColor:transparent,
            so render it here (muted) when the input is empty. */}
        {value.length === 0 && placeholder != null && (
          <span className="text-muted-foreground">{placeholder}</span>
        )}
        {tokens.map((token, idx) => {
          if (token.type === "mention") {
            return (
              <span key={idx} className="text-primary bg-primary/10 rounded-sm">
                {token.value}
              </span>
            );
          }
          if (token.type === "command") {
            return (
              <span
                key={idx}
                className="rounded-sm bg-purple-400/10 text-purple-400"
              >
                {token.value}
              </span>
            );
          }
          return <span key={idx}>{token.value}</span>;
        })}
        {/* trailing space keeps overlay height in sync when text ends with a newline */}{" "}
      </div>
    </div>
  );
};

// ─── Composer ─────────────────────────────────────────────────────────────────

export const ChatComposer = ({
  modelAttention = 0,
  inputRef,
  inputValue,
  onInputValueChange,
  skills = [],
  onSend,
  historyScope,
  onStop,
  isSendLoading,
  canSend,
  placeholder,
  models,
  selectedModelValue,
  onSelectModel,
  selectedModeValue,
  canSelectMode = true,
  compact = false,
  onSelectMode,
  activeWorkspaceId,
  worktrees,
  activeWorktreeId = null,
  worktreeEnvironment,
  worktreeMutationPending = false,
  worktreeMutationError = null,
  onSelectWorktreeEnvironment,
  onModelsRefreshed,
  hasConversation = false,
  workspaceRoot,
  agentStatus,
  pendingPermission,
  onModeChange,
  todos,
  tasksTurnId,
}: ChatComposerProps): JSX.Element => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [attachments, setAttachments] = useState<LocalAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [modelAttentionNonce, setModelAttentionNonce] = useState(0);
  const promptHistory = usePromptHistory(historyScope);
  // Which gate send stopped on, if any. Null means send went through.
  const [sendGate, setSendGate] = useState<"model" | null>(null);
  // Slash-command (skill) picker state.
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  // @file-mention picker state.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [expandedTasksTurnId, setExpandedTasksTurnId] = useState<string | null>(
    null
  );
  const [dismissedTasksTurnId, setDismissedTasksTurnId] = useState<
    string | null
  >(null);
  const overlayInnerRef = useRef<HTMLDivElement>(null);
  const hasWorkspace = activeWorkspaceId != null;
  // Somewhere to work and something to run stand between a message and success.
  // Neither stops typing; send answers with the gate that is shut.
  const isNewChat = hasWorkspace && !hasConversation;
  /** Whether the typed message has grown past its first line. See below. */
  const [isMultiline, setIsMultiline] = useState(false);
  const workspaceKey = activeWorkspaceId ?? "__idle__";
  const deferredMentionQuery = useDeferredValue(mentionQuery);
  const mentionSearchQuery = useQuery({
    queryKey: workspaceQueryKeys.fileMentionSearch(
      workspaceKey,
      deferredMentionQuery ?? ""
    ),
    enabled: hasWorkspace && deferredMentionQuery != null,
    queryFn: () => window.api.agent.searchFiles(deferredMentionQuery ?? ""),
    staleTime: 30_000,
    retry: false,
  });
  const mentionQuerySettled = mentionQuery === deferredMentionQuery;
  const mentionResults = mentionQuerySettled
    ? (mentionSearchQuery.data?.items ?? [])
    : [];
  const mentionOpen = mentionQuery != null;

  // Attachments belong to the composition session, not across workspaces.
  useEffect(() => {
    setAttachments((cur) => {
      cur.forEach((a) => {
        if (a.previewUrl != null) URL.revokeObjectURL(a.previewUrl);
      });
      return [];
    });
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (inputRef.current != null) inputRef.current.style.height = "";
  }, [activeWorkspaceId, hasConversation, inputRef]);

  const homeDirRef = useRef<string | null>(null);
  useEffect(() => {
    void window.api.getHomeDir().then((h) => {
      homeDirRef.current = h;
    });
  }, []);

  // The shortest representation: workspace-relative, then home-relative (~/),
  // then absolute.
  const shortenPath = useCallback(
    (absPath: string): string => {
      const candidates: string[] = [absPath];
      if (workspaceRoot != null) {
        const root = workspaceRoot.replace(/[\\/]+$/, "");
        if (absPath.startsWith(root + "/") || absPath.startsWith(root + "\\")) {
          candidates.push(absPath.slice(root.length + 1));
        }
      }
      const home = homeDirRef.current?.replace(/[\\/]+$/, "");
      if (
        home != null &&
        (absPath.startsWith(home + "/") || absPath.startsWith(home + "\\"))
      ) {
        candidates.push("~/" + absPath.slice(home.length + 1));
      }
      return candidates.reduce((a, b) => (a.length <= b.length ? a : b));
    },
    [workspaceRoot]
  );
  // `isSendLoading` is the single source of truth; `isStreaming` / `agentStatus`
  // only feed the status label and permission pane.
  const isAgentBusy = isSendLoading;
  const isPermissionPending =
    agentStatus === AgentStatus.WaitingForToolPermission &&
    pendingPermission != null;

  const appendFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setAttachments((cur) => [
      ...cur,
      ...files.map((file) => toAttachment(file)),
    ]);
  }, []);

  const removeAttachment = (id: string): void => {
    setAttachments((cur) => {
      const item = cur.find((a) => a.id === id);
      if (item?.previewUrl != null) URL.revokeObjectURL(item.previewUrl);
      return cur.filter((a) => a.id !== id);
    });
  };

  // Staged attachments remember where the file lives, so the send references it.
  const appendRawFiles = useCallback(
    (
      entries: Array<{
        path: string;
        name: string;
        data: Uint8Array | Buffer;
        mimeType: string;
      }>
    ) => {
      if (entries.length === 0) return;
      setAttachments((cur) => [
        ...cur,
        ...entries.map((e) =>
          toAttachment(
            new File([new Uint8Array(e.data)], e.name, { type: e.mimeType }),
            e.path
          )
        ),
      ]);
    },
    []
  );

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData.items)
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter((f): f is File => f != null);
    if (files.length > 0) {
      e.preventDefault();
      appendFiles(files);
    }
  };

  // Insert text at the caret, adding spaces as needed.
  const insertAtCursor = useCallback(
    (text: string) => {
      const el = inputRef.current;
      const start = el?.selectionStart ?? inputValue.length;
      const end = el?.selectionEnd ?? inputValue.length;
      const prefix =
        start > 0 &&
        inputValue[start - 1] !== " " &&
        inputValue[start - 1] !== "\n"
          ? " "
          : "";
      const suffix =
        end < inputValue.length && inputValue[end] !== " " ? " " : "";
      const next =
        inputValue.slice(0, start) +
        prefix +
        text +
        suffix +
        inputValue.slice(end);
      onInputValueChange(next);
      requestAnimationFrame(() => {
        if (el == null) return;
        const cur = start + prefix.length + text.length + suffix.length;
        el.selectionStart = el.selectionEnd = cur;
        el.focus();
      });
    },
    [inputRef, inputValue, onInputValueChange]
  );

  // A folder is referenced, not uploaded: the agent has filesystem access, so
  // an @-mention it can list and read is the useful thing, as a drop gives.
  const handleFolderPicker = useCallback(async () => {
    const folder = await window.api.openFolderDialog();
    if (folder == null || folder.trim().length === 0) return;
    insertAtCursor(`@${shortenPath(folder)}/`);
  }, [insertAtCursor, shortenPath]);

  // Picked files are referenced where they are, the way a Finder drop does.
  const handleFilePicker = useCallback(async () => {
    const selected = await window.api.openFilesDialog("all");
    if (selected == null || selected.length === 0) return;
    appendRawFiles(selected);
  }, [appendRawFiles]);

  const handleAttachAction = useCallback(
    (action: AttachMenuAction): void => {
      switch (action) {
        case "files":
          void handleFilePicker();
          break;
        case "folder":
          void handleFolderPicker();
          break;
      }
    },
    [handleFilePicker, handleFolderPicker]
  );

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      const imageFiles: File[] = [];
      const paths: string[] = [];

      // Paths dragged from the explorer panel (explorer-panel.tsx onDragStart).
      const treePathsJson = e.dataTransfer.getData("text/x-code-paths");
      if (treePathsJson.length > 0) {
        try {
          const treePaths = JSON.parse(treePathsJson) as string[];
          for (const p of treePaths) paths.push(shortenPath(p));
        } catch {
          /* ignore malformed data */
        }
      }

      // OS files (Finder / Explorer / other apps)
      for (const { file, absPath, isDirectory } of resolveDroppedOsFiles(
        e.dataTransfer
      )) {
        if (isDirectory || !file.type.startsWith("image/")) {
          paths.push(shortenPath(absPath));
        } else {
          imageFiles.push(file);
        }
      }

      if (imageFiles.length > 0) appendFiles(imageFiles);
      if (paths.length > 0) insertAtCursor(paths.map((p) => `@${p}`).join(" "));
    },
    [appendFiles, insertAtCursor, shortenPath]
  );

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setIsDragOver(false);
    }
  }, []);

  const closeMentionPicker = useCallback((): void => {
    setMentionQuery(null);
    setMentionSelectedIndex(0);
  }, []);

  // Detect an active @mention at the caret and (re)trigger the search.
  const detectMention = useCallback(
    (value: string): boolean => {
      const el = inputRef.current;
      const cursor = el?.selectionStart ?? value.length;
      const mention = getMentionAtCursor(value, cursor);
      if (mention == null) {
        closeMentionPicker();
        return false;
      }
      setMentionSelectedIndex(0);
      setMentionQuery(mention.query);
      return true;
    },
    [inputRef, closeMentionPicker]
  );

  // Insert `@<relativePath>` (trailing `/` for dirs) plus a space over the range.
  const handleMentionSelect = useCallback(
    (item: FileMentionItem): void => {
      const el = inputRef.current;
      const cursor = el?.selectionStart ?? inputValue.length;
      const mention = getMentionAtCursor(inputValue, cursor);
      if (mention == null) return;
      const before = inputValue.slice(0, mention.startPos);
      const after = inputValue.slice(mention.endPos);
      const suffix = item.kind === "directory" ? "/" : "";
      const insertion = `${formatFileMention(`${item.relativePath}${suffix}`)} `;
      const next = `${before}${insertion}${after}`;
      onInputValueChange(next);
      closeMentionPicker();
      requestAnimationFrame(() => {
        if (el == null) return;
        const pos = mention.startPos + insertion.length;
        el.selectionStart = el.selectionEnd = pos;
        el.focus();
      });
    },
    [inputRef, inputValue, onInputValueChange, closeMentionPicker]
  );

  const handleTextareaChange = (value: string): void => {
    onInputValueChange(value);
    // Typing leaves the history behind; the text stays, but the next up-arrow
    // starts again from the newest prompt.
    promptHistory.reset();
    // A leading `/` with no whitespace opens the picker, but only when something
    // matches, so its logical open state matches its visibility and it does not
    // swallow arrow keys. Any whitespace (newlines too) closes it.
    const slashActive =
      value.startsWith("/") && skills.length > 0 && !/\s/.test(value);
    if (slashActive) {
      const query = value.slice(1).split(/\s/)[0];
      setSlashQuery(query);
      setSlashSelectedIndex(0);
      setSlashMenuOpen(filterSkills(skills, query).length > 0);
      // Only one popup at a time — slash wins over mention.
      closeMentionPicker();
    } else {
      setSlashMenuOpen(false);
      setSlashQuery("");
      // @file-mention detection, when the slash picker isn't taking over.
      detectMention(value);
    }
  };

  /**
   * Grow the box with the text and square it off once it wraps: `rounded-full`
   * on a box this wide is a radius of half its height, so a wrapped message
   * runs out through the curve. Measured, not assumed, because the two
   * composers pad differently. Keyed on the value rather than the change
   * handler because sending and history recall also change it.
   */
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (input == null) return;

    input.style.height = "auto";
    const grown = Math.min(input.scrollHeight, COMPOSER_MAX_HEIGHT);
    input.style.height = `${grown}px`;

    const style = getComputedStyle(input);
    const fontSize = Number.parseFloat(style.fontSize) || 14;
    // `line-height` may resolve to px or stay a unitless ratio; read both.
    const declared = Number.parseFloat(style.lineHeight);
    const line = !Number.isFinite(declared)
      ? fontSize * 1.5
      : style.lineHeight.includes("px")
        ? declared
        : declared * fontSize;
    const padding =
      Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom);
    const oneLine = line + (Number.isFinite(padding) ? padding : 0);

    // A whole extra line, so sub-pixel line boxes never read as a second line.
    setIsMultiline(grown >= oneLine + line);
  }, [inputValue, inputRef]);

  const handleSlashSelect = (skill: SkillMetadata): void => {
    onInputValueChange("/" + skill.id + " ");
    setSlashMenuOpen(false);
    setSlashQuery("");
    setSlashSelectedIndex(0);
    inputRef.current?.focus();
  };

  const queryClient = useQueryClient();

  const branchQuery = useQuery({
    queryKey: workspaceQueryKeys.gitBranches(workspaceKey),
    enabled: activeWorkspaceId != null,
    queryFn: () => window.api.agent.getGitBranches(),
    staleTime: 5_000,
  });

  // Focused query so the chip updates the instant a switch resolves.
  const currentBranchQuery = useQuery({
    queryKey: workspaceQueryKeys.gitCurrentBranch(workspaceKey),
    enabled: activeWorkspaceId != null,
    queryFn: () => window.api.agent.getGitCurrentBranch(),
    staleTime: 5_000,
  });

  // Polled like the CLI (60s); any failure resolves to null and the chips hide.
  const prInfoQuery = useQuery({
    queryKey: workspaceQueryKeys.prInfo(workspaceKey),
    enabled: activeWorkspaceId != null,
    queryFn: () => window.api.agent.getPrInfo(),
    staleTime: 60_000,
    refetchInterval: 60_000,
    // PRs opened or merged outside the app land on window focus too.
    refetchOnWindowFocus: true,
    retry: false,
  });

  const refreshBranches = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.gitBranchesRoot,
      }),
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.gitCurrentBranchRoot,
      }),
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.gitStateRoot,
      }),
      // Branch changed → its PR (if any) changed too.
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.prInfoRoot,
      }),
    ]);
  }, [queryClient]);

  const switchBranchMutation = useMutation({
    mutationFn: (name: string) => window.api.agent.switchGitBranch(name),
    onMutate: async (name: string) => {
      // Optimistic chip label, so the switch shows before `git switch` finishes.
      const key = workspaceQueryKeys.gitCurrentBranch(workspaceKey);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<{
        success: boolean;
        currentBranch: string | null;
        error?: string;
      }>(key);
      queryClient.setQueryData(key, { success: true, currentBranch: name });
      return { previous };
    },
    onError: (_err, _name, ctx) => {
      if (ctx?.previous != null) {
        queryClient.setQueryData(
          workspaceQueryKeys.gitCurrentBranch(workspaceKey),
          ctx.previous
        );
      }
      toast.error(t("workspace.branch.switchFailed"), {
        id: "composer-branch-action",
      });
    },
    onSuccess: async (result, name) => {
      if (!result.success) {
        // Rollback optimistic value
        queryClient.setQueryData(
          workspaceQueryKeys.gitCurrentBranch(workspaceKey),
          {
            success: false,
            currentBranch: currentBranchQuery.data?.currentBranch ?? null,
          }
        );
        toast.error(result.error ?? t("workspace.branch.switchFailed"), {
          id: "composer-branch-action",
        });
        return;
      }
      await refreshBranches();
      const finalName = result.currentBranch ?? name;
      toast.success(t("workspace.branch.switched", { name: finalName }), {
        id: "composer-branch-action",
      });
    },
  });

  const createBranchMutation = useMutation({
    mutationFn: (name: string) => window.api.agent.createGitBranch(name),
    onMutate: async (name: string) => {
      const key = workspaceQueryKeys.gitCurrentBranch(workspaceKey);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<{
        success: boolean;
        currentBranch: string | null;
        error?: string;
      }>(key);
      queryClient.setQueryData(key, { success: true, currentBranch: name });
      return { previous };
    },
    onError: (_err, _name, ctx) => {
      if (ctx?.previous != null) {
        queryClient.setQueryData(
          workspaceQueryKeys.gitCurrentBranch(workspaceKey),
          ctx.previous
        );
      }
    },
    onSuccess: async (result, name) => {
      if (!result.success) {
        queryClient.setQueryData(
          workspaceQueryKeys.gitCurrentBranch(workspaceKey),
          {
            success: false,
            currentBranch: currentBranchQuery.data?.currentBranch ?? null,
          }
        );
        toast.error(result.error ?? t("workspace.branch.createFailed"), {
          id: "composer-branch-action",
        });
        return;
      }
      await refreshBranches();
      const finalName = result.currentBranch ?? name;
      toast.success(
        t("workspace.branch.createdAndSwitched", { name: finalName }),
        {
          id: "composer-branch-action",
        }
      );
    },
  });

  // Image-only sends are allowed. canSend is the panel's composition guard; the
  // presence check here keeps an empty composer from firing.
  const hasContent = inputValue.trim().length > 0 || attachments.length > 0;
  const canSendWithAttachments =
    canSend && !worktreeMutationPending && hasContent;

  const handleSend = useCallback((): void => {
    // One gate: a model to answer with. A missing folder is not one; the send
    // lands in the app's own session folder, so nobody is asked first.
    if (!hasUsableModel(models)) {
      setSendGate("model");
      setModelAttentionNonce((value) => value + 1);
      return;
    }
    setSendGate(null);
    if (!canSendWithAttachments) return;
    // Recorded only for a send that is actually going: a prompt that never left
    // should not be in the history of prompts that did.
    promptHistory.remember(inputValue);
    closeMentionPicker();
    const snapshot = attachments;
    // Cleared synchronously so the next render is empty; the panel saves the
    // bytes to .abacusai-bot/temp and pins paths onto the optimistic segment.
    attachments.forEach((a) => {
      if (a.previewUrl != null) URL.revokeObjectURL(a.previewUrl);
    });
    setAttachments([]);
    void (async () => {
      const outgoing: WorkspaceOutgoingAttachment[] = [];
      for (const a of snapshot) {
        try {
          // A file on disk needs no bytes: the panel references its path.
          const buf =
            a.path == null ? await a.file.arrayBuffer() : new ArrayBuffer(0);
          outgoing.push({
            id: a.id,
            fileName: a.name,
            mimeType: a.mimeType,
            data: new Uint8Array(buf),
            path: a.path,
          });
        } catch (err) {
          toast.error(
            t("workspace.attach.readFailed", {
              name: a.name,
              error:
                err instanceof Error
                  ? err.message
                  : t("workspace.attach.unknownError"),
            })
          );
        }
      }
      void onSend(outgoing);
    })();
  }, [
    attachments,
    canSendWithAttachments,
    models,
    onSend,
    closeMentionPicker,
    t,
  ]);

  // A workspace is the agent's working directory; nothing can run without one.
  const showTasks =
    todos != null &&
    todos.total > 0 &&
    tasksTurnId != null &&
    dismissedTasksTurnId !== tasksTurnId;
  const tasksExpanded = showTasks && expandedTasksTurnId === tasksTurnId;
  const toggleTasks = (): void => {
    if (tasksTurnId == null) return;
    setExpandedTasksTurnId((current) =>
      current === tasksTurnId ? null : tasksTurnId
    );
  };
  const dismissTasks = (): void => {
    if (tasksTurnId != null) setDismissedTasksTurnId(tasksTurnId);
    setExpandedTasksTurnId(null);
  };

  /** Whichever gate send stopped on, opening the thing that shuts it. */
  const openSendGateFix = useCallback((): void => {
    void navigate({ to: "/settings/models", search: {} });
    setSendGate(null);
  }, [navigate]);

  // branches rendered as-is from IPC — no client-side sort
  const branchNames = branchQuery.data?.branches?.map((b) => b.name) ?? [];
  const currentBranch =
    currentBranchQuery.data?.currentBranch ??
    branchQuery.data?.currentBranch ??
    null;
  const isMutating =
    switchBranchMutation.isPending || createBranchMutation.isPending;
  const switchingBranch = switchBranchMutation.isPending
    ? (switchBranchMutation.variables ?? null)
    : null;
  const hasGit = branchQuery.data?.success === true;
  const branchError =
    branchQuery.data?.success === false
      ? (branchQuery.data.error ?? "Unable to read branches.")
      : null;
  const compactComposerExpanded = isMultiline || attachments.length > 0;
  const composerControlRadius =
    compact && !compactComposerExpanded ? "rounded-full" : "rounded-lg";
  // Send stays available mid-turn: a message sent then steers the turn.
  const showSendButton = hasContent && canSend && !worktreeMutationPending;

  return (
    <div
      data-id="local-code-composer"
      className={`@container/composer min-w-0 flex-shrink-0 px-3 pt-1 ${compact ? "pb-2" : "pb-3"}`}
    >
      <div
        // Full window width, iMessage-style; the transcript stays a centered column.
        className="relative mx-auto w-full"
      >
        {tasksExpanded && todos != null && (
          <ComposerTasksDrawer
            todos={todos}
            expanded
            onDismiss={dismissTasks}
            onToggle={toggleTasks}
          />
        )}
        {/* The + rides beside the box in the compact composer, the way a
            message app puts it: outside the bubble, at the start of the row. */}
        <div
          className={
            compact
              ? `flex gap-1 ${compactComposerExpanded ? "items-end" : "items-center"}`
              : "contents"
          }
          data-slot="composer-row"
        >
          {compact && (
            <div
              data-slot="composer-attach"
              className={compactComposerExpanded ? "mb-1.5" : undefined}
            >
              <AttachMenu
                onAction={handleAttachAction}
                asPlus
                buttonClassName={composerControlRadius}
              />
            </div>
          )}
          {/* The pill is right for one line and wrong for a stack: rounded-full
              is a radius of half the box's height, and a permission card's rows
              ran out through the curve. It squares off while a permission is up
              or an attachment strip adds a row, and rounds again after. */}
          <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragEnter={handleDragOver}
            onDragLeave={handleDragLeave}
            data-slot="composer-box"
            className={`bg-sidebar relative z-10 transition-colors ${compact ? `min-w-0 flex-1 ${isPermissionPending || compactComposerExpanded ? "rounded-2xl" : "rounded-full"}` : "rounded-2xl"} ${
              isDragOver
                ? "border-primary/60 bg-primary/5 border-2"
                : // One crisp input surface: a real border that strengthens on focus,
                  // rather than a filled grey slab that has to shout for attention.
                  "border-border focus-within:border-primary/50 border"
            }`}
          >
            {showTasks && !tasksExpanded && todos != null && (
              <ComposerTasksBadge
                todos={todos}
                expanded={false}
                onDismiss={dismissTasks}
                onToggle={toggleTasks}
              />
            )}
            {/* Slash-command (skill) picker — positioned above the composer box */}
            <SlashCommandMenu
              skills={skills}
              query={slashQuery}
              selectedIndex={slashSelectedIndex}
              onSelect={handleSlashSelect}
              visible={slashMenuOpen}
            />

            {/* Drop overlay — shown while dragging, pointer-events-none so drop fires on parent */}
            {isDragOver && (
              <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-xl">
                <Upload className="text-primary size-5" />
                <span className="text-primary text-xs font-medium">
                  {t("workspace.dropFilesHint")}
                </span>
              </div>
            )}
            <Activity
              mode={
                isPermissionPending && pendingPermission != null
                  ? "visible"
                  : "hidden"
              }
            >
              <PermissionPane
                permission={pendingPermission}
                onModeChange={onModeChange}
              />
            </Activity>
            <Activity
              mode={
                isPermissionPending && pendingPermission != null
                  ? "hidden"
                  : "visible"
              }
            >
              <AttachmentStrip
                attachments={attachments}
                onRemove={removeAttachment}
              />
              {/* @file-mention picker — positioned above the composer box */}
              <FileMentionPicker
                results={mentionResults}
                selectedIndex={mentionSelectedIndex}
                onSelect={handleMentionSelect}
                visible={mentionOpen}
                query={mentionQuery ?? ""}
                isLoading={!mentionQuerySettled || mentionSearchQuery.isPending}
                isError={mentionSearchQuery.isError}
              />
              {/* Highlight overlay + transparent textarea stacked in a relative container */}
              <div className="relative">
                <HighlightOverlay
                  value={inputValue}
                  placeholder={
                    placeholder ?? t("workspace.composerPlaceholder")
                  }
                  overlayInnerRef={overlayInnerRef}
                  compact={compact}
                />
                <textarea
                  ref={inputRef}
                  data-id="local-code-input"
                  value={inputValue}
                  aria-autocomplete="list"
                  aria-controls={
                    mentionOpen ? "file-mention-picker" : undefined
                  }
                  aria-expanded={mentionOpen}
                  aria-activedescendant={
                    mentionOpen && mentionResults.length > 0
                      ? `file-mention-option-${mentionSelectedIndex}`
                      : undefined
                  }
                  onChange={(e) => handleTextareaChange(e.target.value)}
                  onScroll={(e) => {
                    if (overlayInnerRef.current != null) {
                      overlayInnerRef.current.style.transform = `translateY(-${e.currentTarget.scrollTop}px)`;
                    }
                  }}
                  onSelect={() => {
                    if (!slashMenuOpen) detectMention(inputValue);
                  }}
                  onBlur={closeMentionPicker}
                  onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
                    if (mentionOpen && mentionResults.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setMentionSelectedIndex((prev) =>
                          Math.min(
                            prev + 1,
                            Math.min(mentionResults.length, 10) - 1
                          )
                        );
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setMentionSelectedIndex((prev) =>
                          Math.max(prev - 1, 0)
                        );
                        return;
                      }
                      if (
                        (e.key === "Enter" && !e.shiftKey) ||
                        e.key === "Tab"
                      ) {
                        e.preventDefault();
                        const item = mentionResults[mentionSelectedIndex];
                        if (item != null) handleMentionSelect(item);
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        closeMentionPicker();
                        return;
                      }
                    }
                    if (slashMenuOpen) {
                      const filtered = filterSkills(skills, slashQuery);
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setSlashSelectedIndex((prev) =>
                          Math.min(prev + 1, filtered.length - 1)
                        );
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setSlashSelectedIndex((prev) => Math.max(prev - 1, 0));
                        return;
                      }
                      // Shift+Enter inserts a newline; only plain Enter / Tab selects.
                      if (
                        ((e.key === "Enter" && !e.shiftKey) ||
                          e.key === "Tab") &&
                        filtered.length > 0
                      ) {
                        e.preventDefault();
                        const skill = filtered[slashSelectedIndex];
                        if (skill != null) handleSlashSelect(skill);
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setSlashMenuOpen(false);
                        return;
                      }
                    }
                    // History, once the open pickers have had their say. Up only
                    // from the first line, down only from the last: a multi-line
                    // prompt is still a thing you move a caret around in.
                    const field = e.currentTarget;
                    const atStart =
                      field.selectionStart === 0 && field.selectionEnd === 0;
                    const atEnd =
                      field.selectionStart === field.value.length &&
                      field.selectionEnd === field.value.length;

                    if (e.key === "ArrowUp" && atStart) {
                      const entry = promptHistory.previous(field.value);
                      if (entry != null) {
                        e.preventDefault();
                        onInputValueChange(entry);

                        return;
                      }
                    }
                    if (
                      e.key === "ArrowDown" &&
                      atEnd &&
                      promptHistory.browsing
                    ) {
                      const entry = promptHistory.next();
                      if (entry != null) {
                        e.preventDefault();
                        onInputValueChange(entry);

                        return;
                      }
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  onPaste={handlePaste}
                  onDropCapture={(event) => event.preventDefault()}
                  onDragOverCapture={(event) => event.preventDefault()}
                  placeholder={
                    isAgentBusy
                      ? t("workspace.composerPlaceholderBusy")
                      : (placeholder ?? t("workspace.composerPlaceholder"))
                  }
                  spellCheck={false}
                  rows={compact ? 1 : isNewChat ? 3 : 2}
                  data-composer-mode={isNewChat ? "new-chat" : "conversation"}
                  // The scrollbar is hidden, not styled: a visible one takes width
                  // from the content box, so text wraps earlier than in the overlay
                  // behind it. `block` matters on the one-line composer: an
                  // inline-block textarea sits on a text baseline and its descender
                  // strip pushed the caret above the pill's centre.
                  className={`placeholder:text-muted-foreground relative w-full resize-none [scrollbar-width:none] bg-transparent ps-3.5 pe-12 focus:outline-none [&::-webkit-scrollbar]:h-0 [&::-webkit-scrollbar]:w-0 ${compact ? "block py-2" : "py-3"}`}
                  style={{
                    fontKerning: "none",
                    fontVariantLigatures: "none",
                    // Same scale as the transcript. Mirrored exactly by HighlightOverlay.
                    fontSize: "14px",
                    lineHeight: 1.5,
                    maxHeight: `${COMPOSER_MAX_HEIGHT}px`,
                    // Typed glyphs hidden so the overlay's tokens show; the caret stays.
                    WebkitTextFillColor: "transparent",
                    caretColor: "var(--foreground, currentColor)",
                  }}
                />
                {/* Send (or stop) sits in the box with the message, bottom
                  right; the toolbar below carries everything else. */}
                <div
                  className={`absolute right-1.5 z-10 flex items-center gap-1 ${
                    compact && !compactComposerExpanded
                      ? "top-1/2 -translate-y-1/2"
                      : "bottom-1.5"
                  }`}
                >
                  {isAgentBusy && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="secondary"
                            size="icon"
                            data-id="local-code-stop-btn"
                            onClick={onStop}
                            className={composerControlRadius}
                          />
                        }
                      >
                        <Square />
                      </TooltipTrigger>
                      <TooltipContent>
                        {t("workspace.stopAgent")}
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {showSendButton ? (
                    <Popover
                      open={sendGate != null}
                      onOpenChange={(open) => {
                        if (!open) setSendGate(null);
                      }}
                    >
                      <div className="relative">
                        {/* The send button cannot be the trigger: it carries the
                        tooltip, and a trigger would toggle the popover on the
                        click that opens it. */}
                        <PopoverTrigger
                          render={
                            <span
                              aria-hidden
                              className="pointer-events-none absolute inset-0"
                            />
                          }
                        />
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="icon"
                                data-id="local-code-send-btn"
                                onClick={handleSend}
                                className={composerControlRadius}
                              />
                            }
                          >
                            <ArrowUp className="pb-px" />
                          </TooltipTrigger>
                          <TooltipContent>
                            {isAgentBusy
                              ? t("workspace.steerMessage")
                              : t("workspace.sendMessage")}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <PopoverContent
                        side="top"
                        align="end"
                        className="w-64 gap-2"
                        data-id="local-code-send-gate"
                      >
                        <PopoverTitle>
                          {t("workspace.sendGate.modelTitle")}
                        </PopoverTitle>
                        <PopoverDescription>
                          {t("workspace.sendGate.modelBody")}
                        </PopoverDescription>
                        <Button
                          size="sm"
                          className="self-start"
                          data-id="local-code-send-gate-cta"
                          onClick={openSendGateFix}
                        >
                          {t("workspace.sendGate.modelCta")}
                        </Button>
                      </PopoverContent>
                    </Popover>
                  ) : null}
                </div>
              </div>
            </Activity>
          </div>
        </div>

        {/* Which checkout the turn runs against. A bot has no picker because
            it has no mode either: nobody is watching to make the call. */}
        {hasGit && canSelectMode && (
          <div
            data-slot="composer-context-rail"
            className="border-border/80 bg-card/80 relative z-0 mx-auto -mt-px flex min-h-8 w-[calc(100%-2rem)] flex-wrap items-center justify-between gap-1 rounded-b-xl border border-t-0 px-1.5 py-0.5 shadow-[0_10px_24px_-22px_rgb(0_0_0/0.9)] backdrop-blur-xl"
          >
            <WorktreePicker
              worktrees={worktrees}
              activeWorktreeId={activeWorktreeId}
              environment={worktreeEnvironment}
              allowNewWorktree={isNewChat}
              disabled={isAgentBusy}
              isPending={worktreeMutationPending}
              error={worktreeMutationError}
              onSelectEnvironment={onSelectWorktreeEnvironment}
            />

            <div className="flex min-w-0 items-center gap-1">
              {branchQuery.isFetching &&
                !branchQuery.isPending &&
                !isMutating && <Spinner fontSize={11} />}
              {prInfoQuery.data != null ? (
                <PrStatusPill pr={prInfoQuery.data} branch={currentBranch} />
              ) : prInfoQuery.isPending ? (
                <Spinner fontSize={11} />
              ) : null}
              {hasGit && (
                <BranchPicker
                  branches={branchNames}
                  currentBranch={currentBranch}
                  isLoading={branchQuery.isPending}
                  isMutating={isMutating}
                  switchingBranch={switchingBranch}
                  onSwitchBranch={(name) => switchBranchMutation.mutate(name)}
                  onCreateBranch={(name) => {
                    if (!isMutating) createBranchMutation.mutate(name);
                  }}
                  branchError={branchError}
                  isAgentBusy={isAgentBusy}
                />
              )}
            </div>
          </div>
        )}

        {/* Intent (mode, attach) on the left, the model on the right; send
            lives inside the box. The compact composer keeps only the model:
            its + moved beside the box and it has no mode to pick. */}
        <div
          className="flex min-w-0 flex-wrap items-center gap-1 px-1 pt-1"
          data-slot="composer-toolbar"
        >
          {(canSelectMode || !compact) && (
            <div className="flex min-w-0 items-center gap-0.5 overflow-hidden">
              {/* Absent, not disabled, in a bot's chat: a greyed-out picker
                  reads as broken. It survives the compact box: what the agent
                  may do is the one control a supervisor needs at hand. */}
              {canSelectMode && (
                <RuntimeModePicker
                  value={selectedModeValue}
                  onChange={onSelectMode}
                  disabled={isAgentBusy}
                />
              )}
              {/* The + moved beside the box when compact, so the menu here
                  would be the same action twice. */}
              {!compact && <AttachMenu onAction={handleAttachAction} />}
            </div>
          )}
          <div className="ms-auto flex shrink-0 items-center">
            <ModelPicker
              models={models}
              onModelsRefreshed={onModelsRefreshed}
              selectedModelValue={selectedModelValue}
              onSelectModel={onSelectModel}
              activeWorkspaceId={activeWorkspaceId}
              attentionNonce={modelAttentionNonce + modelAttention}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
