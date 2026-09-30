/** Sessions pages, phase 1: empty states and the title-bar identity. */
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useTranslation } from "react-i18next";

import { EmptyState } from "#next/components/empty-state";
import { useCollections } from "#next/data/collections";

export const useSession = (sessionId: string) => {
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

export const SessionsNewPage = () => {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon="sessions"
      title={t("sessions.page.newTitle")}
      description={t("sessions.page.newDescription")}
    />
  );
};

export const SessionPage = () => {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon="sessions"
      title={t("sessions.page.sessionTitle")}
      description={t("sessions.page.sessionDescription")}
    />
  );
};

export const SessionReviewPage = () => {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon="sessions"
      title={t("sessions.page.reviewTitle")}
      description={t("sessions.page.reviewDescription")}
    />
  );
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
