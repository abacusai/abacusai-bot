/** Sessions pages, phase 1: empty states and the title-bar identity. */
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";

import { useCollections } from "#next/data/db";

const useSession = (sessionId: string) => {
  const collections = useCollections();
  const { data } = useLiveQuery({
    query: (q) =>
      q
        .from({ s: collections.sessions })
        .where(({ s }) => eq(s.id, sessionId))
        .findOne(),
  });
  return data;
};

export const SessionIdentity = ({ sessionId }: { sessionId: string }) => {
  const session = useSession(sessionId);
  if (session == null) return null;
  return (
    <span className="text-sidebar-foreground truncate font-medium">
      {session.label}
    </span>
  );
};
