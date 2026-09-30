import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import {
  createFileRoute,
  notFound,
  stripSearchParams,
} from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import * as v from "valibot";

import { useCollections } from "#next/data/db";
import {
  ChatView,
  deriveSessionTitle,
  type ComposerConfig,
} from "#next/features/chat";
import { SessionIdentity, SessionPage } from "#next/features/sessions";
import { TopBarSlot } from "#next/features/shell";
import { ignoreLoadError, isMissing } from "#next/lib/navigation/loaders";
import { SESSION_DEFAULTS, SessionSearch } from "#next/lib/navigation/search";
import type { AgentMode } from "#shared/agent-types";
import { SessionId } from "#shared/contract/ids";

/**
 * The session skin of the chat kit (spec 02), as far as phase 2 goes: the
 * transcript, composer, mode chip and permissions. Side-panel tabs, the
 * Changes card, the model picker's contents and the workspace context strip
 * are phase 4's.
 */
const SessionChat = ({ sessionId }: { sessionId: string }) => {
  const { t } = useTranslation();
  const { transport, chat } = Route.useRouteContext();
  const collections = useCollections();
  const { data: row } = useLiveQuery({
    query: (q) =>
      q
        .from({ s: collections.sessions })
        .where(({ s }) => eq(s.id, sessionId))
        .findOne(),
  });
  const { data: workspace } = useLiveQuery(
    {
      query: (q) =>
        q
          .from({ w: collections.workspaces })
          .where(({ w }) => eq(w.id, row?.workspaceId ?? ""))
          .findOne(),
    },
    [row?.workspaceId]
  );
  const root = row?.worktreePath ?? workspace?.path ?? null;
  const turnBusy = row?.turn?.isBusy === true;
  const workspaceId = row?.workspaceId ?? null;
  const routineRun = row?.routineId != null;
  const label = row?.label ?? "";
  // One object per real change, not per row update (review Claude 27): the
  // kit's context value, and every row under it, depends on it.
  const composer = useMemo(
    (): ComposerConfig => ({
      mode: "full",
      placeholder: t("chat.composer.busySession"),
      attachmentsBase: root,
      showModeChip: true,
      model: null,
      turnBusy,
      setMode: (mode: AgentMode) =>
        transport.client.agent.setMode({
          workspaceId: workspaceId ?? "",
          sessionId,
          mode,
        }),
      ...(routineRun
        ? { readOnly: { reason: t("chat.composer.routineRun") } }
        : {}),
      onFirstSend: (text) => {
        if (label.trim() !== "" && label.trim() !== "Untitled") return;
        const title = deriveSessionTitle(text);
        if (title === "") return;
        try {
          collections.sessions.update(sessionId, (draft) => {
            draft.label = title;
          });
        } catch {
          // Titling never blocks a send (spec 02 §8.3).
        }
      },
    }),
    [
      t,
      root,
      turnBusy,
      workspaceId,
      routineRun,
      label,
      transport,
      collections,
      sessionId,
    ]
  );
  if (row == null) return <SessionPage />;
  return (
    <ChatView
      threadId={sessionId}
      skin="session"
      runtime={chat}
      workspaceRoot={root}
      composer={composer}
    />
  );
};

const SessionRoute = () => {
  const { sessionId } = Route.useParams();
  return (
    <>
      <TopBarSlot>
        <SessionIdentity sessionId={sessionId} />
      </TopBarSlot>
      <SessionChat sessionId={sessionId} />
    </>
  );
};

export const Route = createFileRoute("/_shell/(sessions)/sessions/$sessionId")({
  params: { parse: v.parser(v.object({ sessionId: SessionId })) },
  validateSearch: SessionSearch,
  search: { middlewares: [stripSearchParams(SESSION_DEFAULTS)] },
  loaderDeps: ({ search }) => ({ view: search.view }),
  loader: async ({ context, params, preload }) => {
    const { sessions } = context.db.collections;
    await sessions.preload().catch(ignoreLoadError);
    // Only a loaded table can say the session is gone (see bots.$botId).
    if (isMissing(sessions, params.sessionId)) throw notFound();
    // The transcript is present before the view commits (spec 02 §3.2).
    if (preload || !sessions.has(params.sessionId)) return;
    await context.chat.session(params.sessionId).load().catch(ignoreLoadError);
  },
  component: SessionRoute,
});
