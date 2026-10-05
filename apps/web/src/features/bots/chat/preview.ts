/**
 * Where a file or URL a bot mentioned or made opens (spec 03 §11.3a): URLs in
 * the bot's browser tab (phase 4's surface), files in the read-only preview
 * (`?tab=files&preview=`) when the app has a viewer for them, else the OS
 * app. Relative paths resolve against the viewed session's workspace root;
 * guest `/workspace/…` reads are contained by that root.
 */
import { useEffect, useRef } from "react";

import {
  containmentRootFor,
  hasInAppViewer,
  isUrl,
  previewKind,
  resolveWorkspacePath,
} from "#renderer/components/file-preview";
import { followNotice } from "#renderer/data/queries/notices";
import type { Transport } from "#renderer/data/transport";

export type BotOpenTarget =
  | { kind: "browser"; url: string }
  | { kind: "preview"; path: string; hostRoot: string }
  | { kind: "external"; path: string };

export const openBotFile = (
  pathOrUrl: string,
  workspaceRoot: string | null
): BotOpenTarget => {
  if (isUrl(pathOrUrl)) return { kind: "browser", url: pathOrUrl };
  const path = resolveWorkspacePath(pathOrUrl, workspaceRoot);
  if (previewKind(path) === "external") return { kind: "external", path };
  return {
    kind: "preview",
    path,
    hostRoot: containmentRootFor(path, workspaceRoot),
  };
};

/**
 * `files.events { preview-open }` from `present_deliverable`: opens the
 * preview unasked only for this conversation (a key-less event is the
 * visible chat's, as before), and only for URLs and types with an in-app
 * viewer; never launches another app.
 */
export const usePreviewOpenBridge = (
  transport: Transport,
  conversationKey: string | null,
  workspaceRoot: string | null,
  open: (target: BotOpenTarget) => void
): void => {
  const latest = useRef(open);
  useEffect(() => {
    latest.current = open;
  });
  useEffect(() => {
    if (conversationKey == null) return;
    const abort = new AbortController();
    followNotice(
      "files",
      transport,
      (event) => {
        if (event.type !== "preview-open" || event.path.length === 0) return;
        if (
          event.conversationKey != null &&
          event.conversationKey !== conversationKey
        )
          return;
        if (!isUrl(event.path) && !hasInAppViewer(event.path)) return;
        const target = openBotFile(event.path, workspaceRoot);
        if (target.kind === "external") return;
        latest.current(target);
      },
      abort.signal
    );
    return () => abort.abort();
  }, [transport, conversationKey, workspaceRoot]);
};
