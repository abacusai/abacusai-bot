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
    <div className="flex min-w-0 items-center gap-1">
      <span className="text-muted-foreground truncate">
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
          className="truncate font-medium"
          aria-label={t("sessions.sidebar.rename")}
          onClick={() => {
            setLabel(session.label);
            setEditing(true);
            setError(null);
          }}
        >
          {session.label || t("sessions.untitled")}
        </Button>
      )}
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
};
