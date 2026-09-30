import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#next/data/db";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { Button } from "#next/ui/button";

import { SessionContextTray } from "../context/context-tray";
import { useSessionsTransport, useWorkspace } from "../data/queries";
import { SESSION_STARTERS } from "../starters";
import {
  startDraftStore,
  startSession,
  newStartDraft,
  type SubmissionEnvelope,
} from "./start-session";
export interface StartComposerBinding {
  threadId: string;
  root: string | null;
  context: ReactNode;
  submit(envelope: SubmissionEnvelope): Promise<void>;
  blocked: boolean;
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
  const { t } = useTranslation();
  const db = useDb();
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
      onWorkspace={(workspaceId) =>
        startDraftStore.setState((s) => ({ ...s, workspaceId }))
      }
      onWorktree={(worktree) =>
        startDraftStore.setState((s) => ({ ...s, worktree }))
      }
    />
  ) : null;
  return (
    <div
      data-slot="sessions-start"
      className="flex size-full min-h-0 flex-col items-center justify-center px-6 py-8"
    >
      <div className="flex w-full max-w-[680px] flex-col gap-6">
        <h1 className="text-center text-[28px] leading-9 font-semibold">
          {t("sessions.start.heading")}
        </h1>
        {draft.stage !== "draft" ? (
          <div role="status" className="bg-muted rounded-xl p-4">
            <p>{t("sessions.start.finishing")}</p>
            <Button onClick={() => void submit()}>
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
          renderComposer({
            threadId: id,
            root: workspace?.path ?? null,
            context,
            submit,
            blocked: !draft.workspaceId || pathStatus.data?.exists === false,
          })
        )}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <div>
          <p className="text-muted-foreground mb-2 text-xs">
            {t("sessions.start.try")}
          </p>
          <div className="grid grid-cols-3 gap-2">
            {starters.map((starter) => (
              <Button
                key={starter.id}
                variant="secondary"
                className="h-auto min-h-20 flex-col items-start gap-2 rounded-2xl p-3 text-start whitespace-normal"
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
                <span>{t(`sessions.start.starters.${starter.id}.name`)}</span>
                <span className="text-muted-foreground text-xs font-normal">
                  {t(`sessions.start.starters.${starter.id}.detail`)}
                </span>
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
