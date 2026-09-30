import {
  createFileRoute,
  notFound,
  stripSearchParams,
} from "@tanstack/react-router";
import * as v from "valibot";

import { SessionIdentity, SessionPage } from "#next/features/sessions";
import { TopBarSlot } from "#next/features/shell";
import { ignoreLoadError } from "#next/lib/navigation/loaders";
import { SESSION_DEFAULTS, SessionSearch } from "#next/lib/navigation/search";
import { SessionId } from "#shared/contract/ids";

const SessionRoute = () => {
  const { sessionId } = Route.useParams();
  return (
    <>
      <TopBarSlot>
        <SessionIdentity sessionId={sessionId} />
      </TopBarSlot>
      <SessionPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/(sessions)/sessions/$sessionId")({
  params: { parse: v.parser(v.object({ sessionId: SessionId })) },
  validateSearch: SessionSearch,
  search: { middlewares: [stripSearchParams(SESSION_DEFAULTS)] },
  loaderDeps: ({ search }) => ({ view: search.view }),
  loader: async ({ context, params }) => {
    await context.collections.sessions.preload().catch(ignoreLoadError);
    if (!context.collections.sessions.has(params.sessionId)) throw notFound();
  },
  component: SessionRoute,
});
