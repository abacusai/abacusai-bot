import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { useSessionsTransport } from "../data/queries";
import { terminalInChat, terminalList, terminalName } from "./terminal-names";

/**
 * In a delete's confirmation: what the delete stops in its terminals (a dev
 * server, an editor), as the quit and the tab close ask. Where the platform
 * can't tell a program from a prompt (Windows), every open terminal.
 */
export const BusyTerminalsNote = ({
  workspaceId,
  sessionId,
}: {
  workspaceId: string;
  /** One chat's terminals; without it, the whole workspace's. */
  sessionId?: string;
}) => {
  const { t } = useTranslation();
  const transport = useSessionsTransport();
  const busy = useQuery({
    ...transport.orpc.terminal.busyIn.queryOptions({
      input: { workspaceId, ...(sessionId ? { sessionId } : {}) },
    }),
    staleTime: 0,
  });
  const terminals = busy.data ?? [];
  const list = terminalList(terminals, t, (terminal) => {
    const name = terminal.program ?? terminalName(terminal, t);
    return sessionId == null ? terminalInChat(terminal, name, t) : name;
  });
  if (list == null) return null;
  // Programs named where known; otherwise the terminals themselves.
  const known = terminals.every((terminal) => terminal.program != null);
  const text =
    sessionId == null
      ? known
        ? t("sessions.terminal.deleteWorkspaceStops", { list })
        : t("sessions.terminal.deleteWorkspaceCloses", { list })
      : known
        ? t("sessions.terminal.deleteSessionStops", { list })
        : t("sessions.terminal.deleteSessionCloses", { list });
  return (
    <p role="alert" className="text-sm font-medium">
      {text}
    </p>
  );
};
