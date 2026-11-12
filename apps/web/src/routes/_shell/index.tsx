import { createFileRoute, redirect } from "@tanstack/react-router";

import { landOnResumeCard } from "#renderer/features/bots/start/resume-card";
import { lastLocation } from "#renderer/lib/navigation/last-location";

/**
 * Launch: the last shell page, else the start page. After a long time away
 * with a result to pick up, the start page, where its card is.
 */
export const Route = createFileRoute("/_shell/")({
  beforeLoad: ({ context }) => {
    const mark = context.db.collections.prefs.get("app")?.dismissals.resumeCard;
    if (landOnResumeCard(mark, Date.now()))
      throw redirect({ to: "/bots/new", replace: true });
    const href = lastLocation();
    if (href != null) throw redirect({ href, replace: true });
    throw redirect({ to: "/bots/new", replace: true });
  },
});
