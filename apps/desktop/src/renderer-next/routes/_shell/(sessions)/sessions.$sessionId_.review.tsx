import { createFileRoute } from "@tanstack/react-router";

import { SessionIdentity, SessionReviewPage } from "#next/features/sessions";
import { TopBarSlot } from "#next/features/shell";

const SessionReviewRoute = () => {
  const { sessionId } = Route.useParams();
  return (
    <>
      <TopBarSlot>
        <SessionIdentity sessionId={sessionId} />
      </TopBarSlot>
      <SessionReviewPage />
    </>
  );
};

export const Route = createFileRoute(
  "/_shell/(sessions)/sessions/$sessionId_/review"
)({
  component: SessionReviewRoute,
});
