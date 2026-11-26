import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { useSessionsTransport } from "../data/queries";

/**
 * In a delete's confirmation: the programs running in the terminals the
 * delete ends (a dev server, an editor), as the quit and the tab close ask.
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
  if (!busy.data?.length) return null;
  const list = busy.data
    .map(({ program, chat }) =>
      chat && sessionId == null ? `${program} (${chat})` : program
    )
    .join(", ");
  return (
    <p role="alert" className="text-sm font-medium">
      {t("sessions.terminal.deleteStops", { list })}
    </p>
  );
};
