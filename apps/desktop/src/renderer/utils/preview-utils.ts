import { useEffect } from "react";

import {
  conversationRefFromKey,
  type ConversationKey,
} from "#shared/conversation-scope";

import { openPreviewTab } from "../lib/preview-tabs";
import { getActiveConversationKey } from "../stores/active-conversation-store";
import { useWorkspaceStore } from "../stores/code-store";
import type { PreviewItem } from "../stores/preview-store";
import { categorizeFile } from "./file-type-utils";
import { openLocalFile } from "./open-local-file";
import { getPathSegmentName } from "./workspace-state";

export type PreviewTarget = {
  /** Conversation to open into; defaults to the one on screen. */
  scope?: ConversationKey | null;
};

// A conversation not on screen keeps the item and gets the sidebar's green dot
// instead of the pane opening over whatever the user is reading.
const showInPreview = (
  target: PreviewTarget | undefined,
  item: PreviewItem
): void => {
  const active = getActiveConversationKey();
  const scope = target?.scope ?? active;
  if (scope == null) return;
  openPreviewTab(scope, item);
  if (scope === active) {
    const store = useWorkspaceStore.getState();
    store.setActiveRightTab("preview");
    store.setRightPanelVisible(true);
    return;
  }
  const ref = conversationRefFromKey(scope);
  if (ref?.kind === "session")
    useWorkspaceStore.getState().markSessionCompleted(ref.sessionId);
};

/** Guest-side workspace mount; the main process maps it onto the host root. */
const GUEST_WORKSPACE_PREFIX = "/workspace";

/** Absolute on POSIX (`/x`) or Windows (`C:\x`, `\\server\x`). */
export const isAbsoluteFilePath = (value: string): boolean =>
  value.startsWith("/") ||
  /^[a-zA-Z]:[\\/]/.test(value) ||
  value.startsWith("\\\\");

/** Directory holding `filePath`, for both separator conventions. */
export const parentDirectory = (filePath: string): string => {
  const lastSlash = Math.max(
    filePath.lastIndexOf("/"),
    filePath.lastIndexOf("\\")
  );
  return lastSlash > 0 ? filePath.slice(0, lastSlash) : "";
};

// The IPC refuses a read without a containment root. Absolute paths use their
// own directory; guest `/workspace/...` paths need the real workspace path
// because main rewrites them against the host root.
export const containmentRootFor = (
  filePath: string,
  workspacePath: string | null
): string => {
  if (
    filePath === GUEST_WORKSPACE_PREFIX ||
    filePath.startsWith(`${GUEST_WORKSPACE_PREFIX}/`)
  ) {
    return workspacePath ?? "";
  }
  if (isAbsoluteFilePath(filePath)) return parentDirectory(filePath);
  return workspacePath ?? parentDirectory(filePath);
};

// Files the panel renders rather than reads as text; null for the text path.
const renderedPreviewType = (
  filePath: string
): "pptx" | "pdf" | "html" | null => {
  const category = categorizeFile(filePath);
  if (category === "presentation") return "pptx";
  if (category === "html") return "html";
  return filePath.toLowerCase().endsWith(".pdf") ? "pdf" : null;
};

// Anything else opens by handing it to the OS, which launches another app over
// this one: fine on a click, not as a side effect of the agent finishing.
export const hasInAppViewer = (filePath: string): boolean => {
  if (renderedPreviewType(filePath) != null) return true;
  const category = categorizeFile(filePath);
  return (
    category === "image" ||
    category === "markdown" ||
    category === "code" ||
    category === "text"
  );
};

export const openUrlInPreview = (url: string, target?: PreviewTarget): void => {
  showInPreview(target, { type: "url", location: url, title: url });
};

/**
 * Opens the pane when the agent's `present_deliverable` tool asks. Mounted at
 * the app shell, not in the panel: a hidden `<Activity>` unmounts its effects,
 * so a listener there is deaf exactly when the pane is closed. An event with
 * no conversation key falls back to the active chat.
 */
export const usePreviewOpenBridge = (): void => {
  useEffect(() => {
    return window.api.agent.onEvent((event) => {
      if (event.type !== "preview-open" || event.path.length === 0) return;
      const target: PreviewTarget = { scope: event.conversationKey ?? null };
      // A generated app is served on localhost; the same tool carries both.
      if (/^https?:\/\//i.test(event.path)) {
        openUrlInPreview(event.path, target);
        return;
      }
      // Stays in the chat's files card rather than launching Word unasked.
      if (!hasInAppViewer(event.path)) return;
      void openAbsoluteFileInPreview(event.path, undefined, target);
    });
  }, []);
};

export const openAbsoluteFileInPreview = async (
  absPath: string,
  /** Containment root for the read; defaults to the file's own directory. */
  hostRoot?: string,
  target?: PreviewTarget
): Promise<void> => {
  // An empty root makes the IPC refuse the read outright.
  const root =
    hostRoot != null && hostRoot.length > 0
      ? hostRoot
      : parentDirectory(absPath);
  const rendered = renderedPreviewType(absPath);
  if (rendered != null) {
    showInPreview(target, {
      type: rendered,
      location: absPath,
      title: getPathSegmentName(absPath),
      fileAbsPath: absPath,
    });
    return;
  }

  const category = categorizeFile(absPath);
  // Images render in the pane; handing the agent's own output to Preview.app
  // takes the user out of the app to see it.
  if (category === "image") {
    showInPreview(target, {
      type: "image",
      location: absPath,
      title: getPathSegmentName(absPath),
      fileAbsPath: absPath,
    });
    return;
  }
  // A .docx or .xlsx read as text shows the zip's bytes; the OS gets it.
  if (category === "binary" || category === "document") {
    void openLocalFile(absPath);
    return;
  }

  try {
    const result = await window.api.files.readFileAsText({
      filePath: absPath,
      hostRoot: root,
      maxBytes: 2_000_000,
    });
    if (!result.success || result.content == null) {
      void openLocalFile(absPath);
      return;
    }
    showInPreview(target, {
      // Markdown opens rendered; the source stays one toggle away.
      type: category === "markdown" ? "md" : "file",
      location: absPath,
      title: getPathSegmentName(absPath),
      fileContent: result.content,
      fileAbsPath: absPath,
      // The panel locks editing: saving a truncated buffer overwrites the file.
      truncated: result.truncated === true,
    });
  } catch {
    void openLocalFile(absPath);
  }
};

export const openFileInPreview = async (
  relativePath: string,
  workspacePath: string | null,
  target?: PreviewTarget
): Promise<void> => {
  if (relativePath.endsWith("/")) return;
  const absPath = workspacePath
    ? `${workspacePath}/${relativePath}`
    : relativePath;

  const rendered = renderedPreviewType(relativePath);
  if (rendered != null) {
    showInPreview(target, {
      type: rendered,
      location: relativePath,
      title: getPathSegmentName(relativePath),
      fileAbsPath: absPath,
    });
    return;
  }

  const category = categorizeFile(relativePath);
  if (category === "image") {
    showInPreview(target, {
      type: "image",
      location: relativePath,
      title: getPathSegmentName(relativePath),
      fileAbsPath: absPath,
    });
    return;
  }
  if (category === "binary") {
    void openLocalFile(absPath);
    return;
  }

  try {
    const result = await window.api.files.readFileAsText({
      filePath: absPath,
      hostRoot: workspacePath ?? "",
      maxBytes: 2_000_000,
    });
    if (!result.success || result.content == null) {
      void openLocalFile(absPath);
      return;
    }
    showInPreview(target, {
      type: category === "markdown" ? "md" : "file",
      location: relativePath,
      title: getPathSegmentName(relativePath),
      fileContent: result.content,
      fileAbsPath: absPath,
      truncated: result.truncated === true,
    });
  } catch {
    void openLocalFile(absPath);
  }
};
