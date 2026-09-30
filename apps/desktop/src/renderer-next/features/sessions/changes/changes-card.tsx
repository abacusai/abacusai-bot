import { useTranslation } from "react-i18next";

import { Button } from "#next/ui/button";
import type { SessionRow } from "#shared/contract/rows";

import { useGitState } from "../data/queries";
export const SessionChangesCard = ({
  row,
  finished,
  review,
}: {
  row: SessionRow;
  finished: boolean;
  review(): void;
}) => {
  const { t } = useTranslation();
  const state = useGitState({
    workspaceId: row.workspaceId,
    sessionId: row.id,
  });
  const changes = state?.gitChanges ?? [];
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
