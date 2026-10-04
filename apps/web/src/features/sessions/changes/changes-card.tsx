import type { UIMessage } from "@tanstack/ai-client";
import { useTranslation } from "react-i18next";

import { Button } from "#renderer/ui/button";
import type { RunOutcomeRecord } from "#shared/contract/ai-thread";
import type { SessionRow } from "#shared/contract/rows";
import type { GitChangeItem } from "#shared/contracts";

import { useGitState } from "../data/queries";
import { isRelativePath } from "../data/search";
export const SessionChangesCard = ({
  row,
  finished,
  review,
  messages,
  outcomes,
  root,
}: {
  row: SessionRow;
  finished: boolean;
  review(): void;
  messages: readonly UIMessage[];
  outcomes: readonly RunOutcomeRecord[];
  root: string;
}) => {
  const { t } = useTranslation();
  const state = useGitState({
    workspaceId: row.workspaceId,
    sessionId: row.id,
  });
  const changes = lastRunChanges(
    messages,
    outcomes,
    state?.gitChanges ?? [],
    root
  );
  if (!finished || !changes.length) return null;
  return (
    <div
      className="bg-card mx-4 flex items-center justify-between rounded-xl border p-3"
      data-slot="session-changes-card"
    >
      <span>
        {t("sessions.changes.summary", { count: changes.length })}{" "}
        <span className="font-mono text-xs">
          +{changes.reduce((n, c) => n + (c.additions ?? 0), 0)} −
          {changes.reduce((n, c) => n + (c.deletions ?? 0), 0)}
        </span>
      </span>
      <Button size="sm" variant="secondary" onClick={review}>
        {t("sessions.changes.review")}
      </Button>
    </div>
  );
};

/** Outcome message fences survive hydrate; never infer a run from current git changes. */
export const lastRunChanges = (
  messages: readonly UIMessage[],
  outcomes: readonly RunOutcomeRecord[],
  changes: readonly GitChangeItem[],
  root: string
): GitChangeItem[] => {
  if (!root) return [];
  const latest = outcomes.at(-1);
  if (latest?.kind !== "success" || !latest.afterMessageId) return [];
  const end = messages.findIndex((m) => m.id === latest.afterMessageId);
  const previous = outcomes.at(-2)?.afterMessageId;
  const start = previous ? messages.findIndex((m) => m.id === previous) : -1;
  if (end < 0 || (previous && start < 0)) return [];
  const paths = new Set<string>();
  const collect = (input: unknown, depth = 0) => {
    if (depth > 10) return;
    if (!input || typeof input !== "object") return;
    const record = input as Record<string, unknown>;
    for (const value of [
      record.path,
      record.file_path,
      record.filePath,
      record.notebook_path,
    ]) {
      if (typeof value !== "string") continue;
      const normalized = value.replaceAll("\\", "/");
      const base = root.replaceAll("\\", "/").replace(/\/$/, "");
      const relative = (
        normalized.startsWith(base + "/")
          ? normalized.slice(base.length + 1)
          : normalized
      ).replace(/^\.\//, "");
      if (isRelativePath(relative)) paths.add(relative);
    }
    for (const key of ["edits", "files"])
      if (Array.isArray(record[key]))
        for (const item of record[key]) collect(item, depth + 1);
  };
  for (const message of messages.slice(start + 1, end + 1))
    for (const part of message.parts) {
      if (
        part.type !== "tool-call" ||
        !["edit", "write", "ast_edit", "batch_edit", "notebook_edit"].includes(
          part.name
        ) ||
        part.state === "error"
      )
        continue;
      try {
        collect(part.input ?? JSON.parse(part.arguments));
      } catch {}
    }
  return changes.filter((change) => paths.has(change.path));
};
