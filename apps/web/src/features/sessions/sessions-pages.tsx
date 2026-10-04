import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#renderer/data/db";
import { Button } from "#renderer/ui/button";
import { Input } from "#renderer/ui/input";

import { useSession, useWorkspace } from "./data/queries";
import { renameSession } from "./data/session-actions";

export const SessionIdentity = ({ sessionId }: { sessionId: string }) => {
  const { t } = useTranslation();
  const db = useDb();
  const session = useSession(sessionId);
  const workspace = useWorkspace(session?.workspaceId ?? "");
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!session) return null;
  return (
    <div className="flex max-w-full min-w-0 flex-1 items-center gap-1">
      <span className="text-muted-foreground hidden max-w-40 shrink-0 truncate xl:inline">
        {workspace?.label} /
      </span>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void renameSession(db, sessionId, label)
              .then(() => setEditing(false))
              .catch((e) => setError(String(e)));
          }}
        >
          <Input
            autoFocus
            value={label}
            aria-label={t("sessions.sidebar.name")}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
            }}
          />
        </form>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 shrink justify-start overflow-hidden font-medium"
          title={session.label}
          aria-label={t("sessions.sidebar.rename")}
          onClick={() => {
            setLabel(session.label);
            setEditing(true);
            setError(null);
          }}
        >
          <span className="truncate">
            {session.label || t("sessions.untitled")}
          </span>
        </Button>
      )}
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
};
