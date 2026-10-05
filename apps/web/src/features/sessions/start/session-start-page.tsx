import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import {
  GitPullRequest,
  PieChart,
  Plane,
  ShoppingBag,
  Sparkles,
  Table2,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#renderer/data/db";
import { isListedSession } from "#renderer/data/db/filters";
import { usePrefs } from "#renderer/data/db/prefs";
import { formatChatStamp } from "#renderer/lib/format/chat-stamp";
import { AppLink } from "#renderer/lib/navigation/app-link";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { Button } from "#renderer/ui/button";

import { SessionContextTray } from "../context/context-tray";
import { useSessionsTransport, useWorkspace } from "../data/queries";
import { SESSION_STARTERS } from "../starters";
import {
  startDraftStore,
  startSession,
  newStartDraft,
  optimisticSession,
  type SubmissionEnvelope,
} from "./start-session";
/** Phone starter cards lead with an icon, the way native quick prompts do. */
const STARTER_ICONS: Record<string, LucideIcon> = {
  "review-pull-requests": GitPullRequest,
  "design-an-infographic": PieChart,
  "build-a-store": ShoppingBag,
  "process-a-spreadsheet": Table2,
  "restyle-a-repo": Wand2,
  "find-flights": Plane,
};
export interface StartComposerBinding {
  threadId: string;
  workspaceId: string | null;
  root: string | null;
  context: ReactNode;
  submit(envelope: SubmissionEnvelope): Promise<void>;
  blocked: boolean;
  attachmentContext(): Promise<{ workspaceId: string; sessionId: string }>;
}
export const SessionStartPage = ({
  workspaceId,
  renderComposer,
  handoff,
  prefill,
}: {
  workspaceId: string | null;
  renderComposer: (binding: StartComposerBinding) => ReactNode;
  handoff: (id: string, envelope: SubmissionEnvelope) => void;
  prefill: (id: string, text: string) => void;
}) => {
  const { t, i18n } = useTranslation();
  const db = useDb();
  const prefs = usePrefs();
  const { data: recent } = useLiveQuery(db.collections.sessions);
  const transport = useSessionsTransport();
  const navigate = useAppNavigate();
  const draft = useSelector(startDraftStore, (s) => s);
  const workspace = useWorkspace(draft.workspaceId ?? workspaceId ?? "");
  const pathStatus = useQuery({
    ...transport.orpc.workspaces.checkPath.queryOptions({
      input: { workspaceId: draft.workspaceId ?? workspaceId ?? "" },
    }),
    enabled: !!(draft.workspaceId ?? workspaceId),
    refetchOnWindowFocus: true,
  });
  const [now] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (draft.stage === "draft" && draft.workspaceId === null && workspaceId)
      startDraftStore.setState((s) => ({ ...s, workspaceId }));
  }, [workspaceId, draft.workspaceId, draft.stage]);
  const submit = async (envelope?: SubmissionEnvelope) => {
    setError(null);
    try {
      await startSession(
        {
          db,
          client: transport.client,
          handoff,
          navigate: (id) =>
            navigate({
              to: "/sessions/$sessionId",
              params: { sessionId: id },
              transition: "nav-forward",
            }),
        },
        envelope
      );
    } catch (e) {
      setError(String(e));
      throw e;
    }
  };
  const id = `draft:${draft.id}`;
  const starters = SESSION_STARTERS;
  const context = draft.workspaceId ? (
    <SessionContextTray
      workspaceId={draft.workspaceId}
      worktree={draft.worktree}
      onWorkspace={
        draft.stage === "draft"
          ? (workspaceId) =>
              startDraftStore.setState((s) => ({ ...s, workspaceId }))
          : undefined
      }
      onWorktree={(worktree) =>
        startDraftStore.setState((s) => ({ ...s, worktree }))
      }
    />
  ) : null;
  return (
    <div
      data-slot="sessions-start"
      className="phone:justify-end phone:px-0 phone:pt-6 phone:pb-3 flex size-full min-h-0 flex-col items-center justify-center px-6 py-8"
    >
      {/* Phones read bottom-up like a native agent screen: headline, a
          swipeable row of starters, then the composer under the thumb. */}
      <div className="phone:gap-5 flex w-full max-w-[680px] flex-col gap-6">
        <h1 className="phone-rise phone:px-5 phone:text-start phone:text-[32px] phone:leading-[38px] phone:tracking-tight text-center text-[28px] leading-9 font-semibold">
          {t("sessions.start.heading")}
        </h1>
        {draft.stage !== "draft" ? (
          <div
            role="status"
            className="bg-muted phone:order-4 phone:mx-3 rounded-xl p-4"
          >
            <p>{t("sessions.start.finishing")}</p>
            <p className="whitespace-pre-wrap">
              {draft.envelope?.parts
                .filter((part) => part.type === "text")
                .map((part) => part.content)
                .join("\n")}
            </p>
            {draft.stage === "created" ? context : null}
            <Button onClick={() => void submit().catch(() => {})}>
              {t("sessions.start.continue")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                void db.collections.sessions
                  .delete(draft.id)
                  .isPersisted.promise.then(() =>
                    startDraftStore.setState(() => {
                      const next = newStartDraft();
                      prefill(
                        `draft:${next.id}`,
                        draft.envelope?.parts
                          .filter((p) => p.type === "text")
                          .map((p) => p.content)
                          .join("\n") ?? ""
                      );
                      return { ...next, workspaceId: draft.workspaceId };
                    })
                  );
              }}
            >
              {t("sessions.start.discard")}
            </Button>
          </div>
        ) : (
          <div
            className="phone-rise phone:order-4 phone:px-3"
            style={{ "--rise-i": 3 } as CSSProperties}
          >
            {renderComposer({
              threadId: id,
              attachmentContext: async () => {
                if (!draft.workspaceId)
                  throw new Error("Select a workspace before uploading files");
                await db.collections.sessions.preload();
                const existing = db.collections.sessions.get(draft.id);
                if (existing && existing.workspaceId !== draft.workspaceId)
                  throw new Error(
                    "Session identity belongs to another workspace"
                  );
                if (!existing)
                  await db.collections.sessions.insert(optimisticSession(draft))
                    .isPersisted.promise;
                return { workspaceId: draft.workspaceId, sessionId: draft.id };
              },
              workspaceId: draft.workspaceId,
              root: workspace?.path ?? null,
              context,
              submit,
              blocked: !draft.workspaceId || pathStatus.data?.exists === false,
            })}
          </div>
        )}
        {error ? (
          <p
            role="alert"
            className="text-destructive phone:order-5 phone:px-5 text-sm"
          >
            {error}
          </p>
        ) : null}
        {!prefs.sidebar.pinned &&
        workspace &&
        (recent ?? []).some(
          (s) => isListedSession(s) && s.workspaceId === workspace.id
        ) ? (
          <div className="phone:order-2 phone:px-3">
            <h2 className="phone:px-2 text-sm">
              {t("sessions.start.recent", {
                workspace:
                  workspace.label || workspace.path?.split(/[\\/]/).pop(),
              })}
            </h2>
            {(recent ?? [])
              .filter(
                (s) => isListedSession(s) && s.workspaceId === workspace?.id
              )
              .toSorted(
                (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
              )
              .slice(0, 4)
              .map((s) => (
                <AppLink
                  key={s.id}
                  to="/sessions/$sessionId"
                  params={{ sessionId: s.id }}
                  className="flex justify-between rounded-lg p-2 text-sm"
                >
                  <span>{s.label || t("sessions.untitled")}</span>
                  <time dateTime={s.updatedAt}>
                    {formatChatStamp(
                      Date.parse(s.updatedAt),
                      now,
                      i18n.language,
                      t("sessions.yesterday")
                    )}
                  </time>
                </AppLink>
              ))}
          </div>
        ) : null}
        <div className="phone:order-3">
          <p
            className="phone-rise text-foreground/75 phone:px-5 mb-2 text-xs"
            style={{ "--rise-i": 1 } as CSSProperties}
          >
            {t("sessions.start.try")}
          </p>
          <div className="phone:flex phone:snap-x phone:snap-mandatory phone:overflow-x-auto phone:px-5 phone:scroll-px-5 no-scrollbar grid grid-cols-3 gap-2">
            {starters.map((starter, index) => (
              <Button
                key={starter.id}
                variant="secondary"
                style={{ "--rise-i": index + 1 } as CSSProperties}
                className="phone-rise phone:h-[132px] phone:w-[156px] phone:shrink-0 phone:snap-start phone:justify-between h-auto min-h-20 flex-col items-start gap-2 rounded-2xl p-3 text-start whitespace-normal"
                onClick={() => {
                  prefill(id, starter.prompt);
                  requestAnimationFrame(() =>
                    document
                      .querySelector<HTMLTextAreaElement>(
                        '[data-slot="composer"] textarea'
                      )
                      ?.focus()
                  );
                }}
              >
                {(() => {
                  const Icon = STARTER_ICONS[starter.id] ?? Sparkles;
                  return (
                    <Icon
                      aria-hidden
                      className="text-muted-foreground phone:block hidden size-4"
                    />
                  );
                })()}
                <span className="flex flex-col gap-1">
                  <span>{t(`sessions.start.starters.${starter.id}.name`)}</span>
                  <span className="text-foreground/75 phone:line-clamp-2 text-xs font-normal">
                    {t(`sessions.start.starters.${starter.id}.detail`)}
                  </span>
                </span>
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
