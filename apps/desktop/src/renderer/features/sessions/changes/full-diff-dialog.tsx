import { useQuery } from "@tanstack/react-query";
import { createPatch } from "diff";
import { useTranslation } from "react-i18next";

import { DiffView } from "#renderer/components/diff-view";
import { Button } from "#renderer/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "#renderer/ui/dialog";

import {
  useCheckoutIdentity,
  useSessionsTransport,
  useGitState,
} from "../data/queries";
import { readDiff } from "./diff-source";
export const FullDiffDialog = ({
  sessionId,
  workspaceId,
  root,
  path,
  scope = "unstaged",
  source,
  toolKey,
  mode = "unified",
  resolveTool,
  onClose,
  onGit,
}: {
  sessionId: string;
  workspaceId: string;
  root: string;
  path: string;
  scope?: "staged" | "unstaged";
  source: "git" | "tool";
  toolKey?: string;
  mode?: "unified" | "split";
  resolveTool: () => Promise<
    | { state: "ready"; original: string; final: string }
    | { state: "unavailable" }
  >;
  onClose: () => void;
  onGit: () => void;
}) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const git = useGitState({ workspaceId, sessionId });
  const checkoutIdentity = useCheckoutIdentity({ workspaceId, sessionId });
  const fingerprint = git?.gitChanges.find((change) => change.path === path)
    ?.fingerprints?.[scope];
  const result = useQuery({
    queryKey: [
      "sessions.fullDiff",
      checkoutIdentity,
      sessionId,
      path,
      scope,
      source,
      toolKey,
      fingerprint,
    ],
    queryFn: async () => {
      if (source === "tool") {
        const tool = await resolveTool();
        return tool.state === "ready"
          ? {
              kind: "patch",
              patch: createPatch(path, tool.original, tool.final),
            }
          : { kind: "unavailable" };
      }
      return readDiff(
        transport.client,
        { workspaceId, sessionId },
        path,
        scope,
        root
      );
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-64px)] w-[calc(100vw-64px)] flex-col overflow-hidden sm:max-w-[1200px]">
        <DialogHeader>
          <DialogTitle className="pr-8 break-all">{path}</DialogTitle>
          <DialogDescription>{t("sessions.changes.diff")}</DialogDescription>
        </DialogHeader>
        {result.data?.kind === "patch" ? (
          <div className="max-h-[70dvh] min-h-40 overflow-auto">
            <DiffView patch={result.data.patch ?? ""} mode={mode} />
          </div>
        ) : (
          <div
            role="status"
            className="flex min-h-40 flex-col items-center justify-center gap-4"
          >
            {t(
              result.isPending
                ? "common.loading"
                : "sessions.changes.unavailable"
            )}
            <Button variant="secondary" onClick={onGit}>
              {t("sessions.changes.gitFallback")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
