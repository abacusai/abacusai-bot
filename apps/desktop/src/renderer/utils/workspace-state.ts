import type { WorkspaceState } from "#shared/contracts";

export const initialWorkspaceState: WorkspaceState = {
  workspaces: [],
  activeWorkspaceId: null,
  worktrees: [],
  sessions: [],
  chats: [],
  utilityTabs: ["explorer", "terminal", "agents"],
  agentRuns: [],
  fileTree: [],
  gitChanges: [],
  gitDiffHunks: [],
  gitAvailable: false,
  gitStatusMessage: "No workspace selected.",
  materialIconsBasePath: null,
  lastUpdatedAt: new Date(0).toISOString(),
};

export const getPathSegmentName = (value: string): string => {
  // Defensive: callers like `getWorkspaceDisplayLabel` derive `value` from
  // `workspace.path ?? workspace.description`, both nominally string. But IPC
  // payloads aren't runtime-validated and a malformed entry has crashed
  // render with "X.replace is not a function" on Windows.
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalized.length === 0) {
    return value;
  }
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? value;
};

export const getWorkspaceDisplayLabel = (
  workspace: WorkspaceState["workspaces"][number]
): string => {
  if (workspace.label.length > 0) {
    return workspace.label;
  }
  const value = workspace.path ?? workspace.description;
  return getPathSegmentName(value);
};

export const normalizeWorkspaceState = (
  candidate: Partial<WorkspaceState> | null | undefined
): WorkspaceState => {
  if (candidate == null || typeof candidate !== "object") {
    return initialWorkspaceState;
  }

  return {
    workspaces: Array.isArray(candidate.workspaces) ? candidate.workspaces : [],
    activeWorkspaceId:
      typeof candidate.activeWorkspaceId === "string" ||
      candidate.activeWorkspaceId == null
        ? (candidate.activeWorkspaceId ?? null)
        : null,
    worktrees: Array.isArray(candidate.worktrees) ? candidate.worktrees : [],
    sessions: Array.isArray(candidate.sessions) ? candidate.sessions : [],
    chats: Array.isArray(candidate.chats) ? candidate.chats : [],
    utilityTabs: Array.isArray(candidate.utilityTabs)
      ? candidate.utilityTabs
      : initialWorkspaceState.utilityTabs,
    agentRuns: Array.isArray(candidate.agentRuns) ? candidate.agentRuns : [],
    fileTree: Array.isArray(candidate.fileTree) ? candidate.fileTree : [],
    gitChanges: Array.isArray(candidate.gitChanges) ? candidate.gitChanges : [],
    gitDiffHunks: Array.isArray(candidate.gitDiffHunks)
      ? candidate.gitDiffHunks
      : [],
    gitAvailable:
      typeof candidate.gitAvailable === "boolean"
        ? candidate.gitAvailable
        : false,
    gitStatusMessage:
      typeof candidate.gitStatusMessage === "string"
        ? candidate.gitStatusMessage
        : initialWorkspaceState.gitStatusMessage,
    materialIconsBasePath:
      typeof candidate.materialIconsBasePath === "string" ||
      candidate.materialIconsBasePath == null
        ? (candidate.materialIconsBasePath ?? null)
        : null,
    lastUpdatedAt:
      typeof candidate.lastUpdatedAt === "string"
        ? candidate.lastUpdatedAt
        : new Date().toISOString(),
  };
};

const getChangeType = (
  status: string
): "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflict" => {
  if (status.includes("R")) {
    return "renamed";
  }
  if (status.includes("A")) {
    return "added";
  }
  if (status.includes("D")) {
    return "deleted";
  }
  if (status.includes("U")) {
    return "conflict";
  }
  if (status.includes("?")) {
    return "untracked";
  }
  return "modified";
};

export const getChangePresentation = (
  status: string
): { label: string; className: string } => {
  const type = getChangeType(status);
  switch (type) {
    case "added":
      return { label: "A", className: "text-emerald-400" };
    case "deleted":
      return { label: "D", className: "text-rose-400" };
    case "renamed":
      return { label: "R", className: "text-sky-400" };
    case "untracked":
      return { label: "U", className: "text-emerald-400" };
    case "conflict":
      return { label: "C", className: "text-orange-400" };
    default:
      return { label: "M", className: "text-amber-400" };
  }
};
