import { useQuery } from "@tanstack/react-query";
import { createPatch } from "diff";
import { useTranslation } from "react-i18next";

import { DiffView } from "#next/components/diff-view";
import { Button } from "#next/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "#next/ui/dialog";

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
      <DialogContent className="flex h-[90vh] w-[90vw] max-w-[1200px] flex-col">
        <DialogHeader>
          <DialogTitle>{path}</DialogTitle>
          <DialogDescription>{t("sessions.changes.diff")}</DialogDescription>
        </DialogHeader>
        {result.data?.kind === "patch" ? (
          <DiffView patch={result.data.patch ?? ""} mode={mode} />
        ) : (
          <div role="status">
            {t("sessions.changes.unavailable")}
            <Button variant="secondary" onClick={onGit}>
              {t("sessions.changes.gitFallback")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
