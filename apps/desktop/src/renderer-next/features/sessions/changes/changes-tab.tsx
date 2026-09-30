import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DiffView } from "#next/components/diff-view";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "#next/ui/alert-dialog";
import { Button } from "#next/ui/button";
import type { SessionRow } from "#shared/contract/rows";
import type { GitChangeItem } from "#shared/contracts";

import { useGitState, useSessionsTransport } from "../data/queries";
import { readDiff } from "./diff-source";
import { reviewStore, keepChange, isReviewed } from "./review-store";
export interface ChangeSelection {
  change: GitChangeItem;
  scope: "staged" | "unstaged";
  group: string;
}
export const changeRows = (
  state: ReturnType<typeof useGitState>
): ChangeSelection[] => {
  if (!state) return [];
  const sections = state.gitChangeSections;
  return sections
    ? [
        ...sections.staged.map((change) => ({
          change,
          scope: "staged" as const,
          group: "staged",
        })),
        ...sections.unstaged.map((change) => ({
          change,
          scope: "unstaged" as const,
          group: "unstaged",
        })),
        ...sections.merged.map((change) => ({
          change,
          scope: "unstaged" as const,
          group: "merged",
        })),
      ]
    : state.gitChanges.map((change) => ({
        change,
        scope: "unstaged" as const,
        group: "unstaged",
      }));
};
export const ChangesTab = ({
  row,
  root,
  onDiff,
}: {
  row: SessionRow;
  root: string;
  onDiff: (path: string, scope: "staged" | "unstaged") => void;
}) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const checkout = { workspaceId: row.workspaceId, sessionId: row.id };
  const state = useGitState(checkout);
  const rows = changeRows(state);
  const search = useSearch({ strict: false }) as {
    file?: string;
    scope?: string;
  };
  const navigate = useAppNavigate();
  const [undo, setUndo] = useState<ChangeSelection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useSelector(reviewStore, (s) => s[row.id]);
  const selected =
    rows.find(
      (r) =>
        r.change.path === search.file &&
        (!search.scope || r.scope === search.scope)
    ) ?? rows[0];
  const fingerprint = selected?.change.fingerprints?.[selected.scope];
  const diff = useQuery({
    queryKey: [
      "sessions.diff",
      state?.checkoutKey,
      selected?.change.path,
      selected?.scope,
      fingerprint,
    ],
    enabled: !!selected,
    queryFn: () =>
      readDiff(
        transport.client,
        checkout,
        selected!.change.path,
        selected!.scope,
        root
      ),
  });
  const select = (index: number) => {
    const target = rows[(index + rows.length) % rows.length];
    if (target)
      void navigate({
        to: ".",
        search: (p: Record<string, unknown>) => ({
          ...p,
          file: target.change.path,
          scope: target.scope,
        }),
        replace: true,
        transition: "none",
      } as never);
  };
  const keep = (selection: ChangeSelection) => {
    const fp = selection.change.fingerprints?.[selection.scope];
    if (fp) keepChange(row.id, selection.change.path, selection.scope, fp);
  };
  const discard = async () => {
    if (!undo) return;
    try {
      const untracked = undo.filter((r) => r.change.status === "??");
      for (const item of untracked)
        await transport.client.files.trash({
          checkout,
          filePath: item.change.path,
        });
      const tracked = undo.filter((r) => r.change.status !== "??");
      if (tracked.length) {
        const result = await transport.client.git.discard({
          checkout,
          entries: tracked.map((r) => ({
            path: r.change.path,
            ...(r.change.origPath ? { origPath: r.change.origPath } : {}),
          })),
        });
        if (result.failed.length)
          throw new Error(result.failed.map((f) => f.detail).join("\n"));
      }
      setUndo(null);
    } catch (e) {
      setError(String(e));
    }
  };
  if (!rows.length)
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center">
        {t("sessions.changes.empty")}
      </div>
    );
  return (
    <div className="flex size-full min-h-0">
      <aside className="flex w-[232px] shrink-0 flex-col gap-1 overflow-auto border-r p-2">
        <p className="text-muted-foreground p-2 text-xs">
          {t("sessions.changes.title")}
        </p>
        {rows.map((r, i) => (
          <div key={`${r.group}:${r.change.path}`}>
            <p className="text-muted-foreground px-2 text-xs">
              {i === 0 || rows[i - 1]?.group !== r.group
                ? t(`sessions.changes.${r.group}`)
                : ""}
            </p>
            <Button
              variant={selected === r ? "secondary" : "ghost"}
              className="h-12 w-full flex-col items-start gap-0.5"
              style={
                isReviewed(
                  row.id,
                  r.change.path,
                  r.scope,
                  r.change.fingerprints?.[r.scope]
                )
                  ? { opacity: 0.6 }
                  : undefined
              }
              onClick={() => select(i)}
            >
              <span className="max-w-full truncate">{r.change.path}</span>
              <span className="font-mono text-[11px]">
                +{r.change.additions} −{r.change.deletions}
                {isReviewed(
                  row.id,
                  r.change.path,
                  r.scope,
                  r.change.fingerprints?.[r.scope]
                )
                  ? " ✓"
                  : ""}
              </span>
            </Button>
          </div>
        ))}
      </aside>
      <section
        className="flex min-w-0 flex-1 flex-col"
        onKeyDown={(e) => {
          if (e.key === "n" || e.key === "p") {
            e.preventDefault();
            select(rows.indexOf(selected!) + (e.key === "n" ? 1 : -1));
          }
        }}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {selected?.change.path}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setUndo([selected!])}
          >
            {t("sessions.changes.undo")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              keep(selected!);
              select(rows.indexOf(selected!) + 1);
            }}
          >
            {t("sessions.changes.keep")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDiff(selected!.change.path, selected!.scope)}
          >
            {t("sessions.changes.fullDiff")}
          </Button>
        </div>
        {error ? <p role="alert">{error}</p> : null}
        {diff.data?.kind === "patch" ? (
          <DiffView patch={diff.data.patch ?? ""} />
        ) : (
          <p role="status" className="p-4 text-sm">
            {diff.isPending
              ? t("sessions.changes.loading")
              : diff.data?.kind === "binary"
                ? t("sessions.changes.binary")
                : t("sessions.changes.noSection")}
          </p>
        )}
      </section>
      <AlertDialog
        open={!!undo}
        onOpenChange={(open) => !open && setUndo(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("sessions.changes.undoTitle", {
                file: undo?.[0]?.change.path,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("sessions.changes.undoBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("sessions.common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void discard()}>
              {t("sessions.changes.undo")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
