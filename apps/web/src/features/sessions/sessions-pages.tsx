import { Pencil } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#renderer/data/db";
import { CommandCenter } from "#renderer/features/shell/command-center";
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
    <div className="flex max-w-full min-w-0 flex-1 items-center justify-center gap-1">
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            // The title shows the new name at once; a refusal puts the old
            // one back and says why.
            setEditing(false);
            void renameSession(db, sessionId, label).catch((e) =>
              setError(String(e))
            );
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
        <>
          <CommandCenter
            title={session.label || t("sessions.untitled")}
            context={workspace?.label}
          />
          <Button
            variant="ghost"
            size="icon-xs"
            className="titlebar-nodrag text-muted-foreground shrink-0"
            title={session.label}
            aria-label={t("sessions.sidebar.rename")}
            onClick={() => {
              setLabel(session.label);
              setEditing(true);
              setError(null);
            }}
          >
            <Pencil className="size-3" />
          </Button>
        </>
      )}
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
};
