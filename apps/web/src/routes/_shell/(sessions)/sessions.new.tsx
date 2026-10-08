import { draftConversationKey } from "@abacus-ai/contract/conversation-scope";
import { createFileRoute } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { usePrefs } from "#renderer/data/db/prefs";
import { updateDraft } from "#renderer/features/chat/composer/draft-store";
import { StartComposer } from "#renderer/features/chat/composer/start-composer";
import { useSessionComposerModel } from "#renderer/features/sessions/data/composer-model";
import { restoreSessionDraft } from "#renderer/features/sessions/start/session-drafts";
import { SessionStartPage } from "#renderer/features/sessions/start/session-start-page";
import { SessionStartResources } from "#renderer/features/sessions/start/start-resources";
import {
  prepareStartDraft,
  rejectStartSubmission,
  startDraftStore,
} from "#renderer/features/sessions/start/start-session";
import { nativePresenterFor } from "#renderer/features/shell/platform-presenter";
import { registerPreviewConsumer } from "#renderer/features/shell/preview-consumers";
import { shellStore } from "#renderer/features/shell/shell-store";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";
import { NewSessionSearch } from "#renderer/lib/navigation/search";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
const SessionsNewRoute = () => {
  const { t } = useTranslation();
  const { transport, chat } = Route.useRouteContext();
  const { workspaceId, draftId } = Route.useLoaderData();
  const draft = useSelector(startDraftStore, (s) => s);
  const search = Route.useSearch();
  const navigate = useAppNavigate();
  const model = useSessionComposerModel(undefined, `draft:${draft.id}`);
  useEffect(() => {
    if (draftId === startDraftStore.state.id && search.draft !== draftId)
      void navigate({
        to: "/sessions/new",
        search: { ...search, draft: draftId },
        replace: true,
        transition: "none",
      });
  }, [draftId, search, navigate]);
  const prefs = usePrefs();
  return (
    <>
      <TopBarSlot>
        <span className="font-medium">{t("sessions.page.newTitle")}</span>
      </TopBarSlot>
      <SessionStartResources
        workspaceId={workspaceId}
        register={(key, open) =>
          registerPreviewConsumer({
            owns: (scope) => scope === undefined || scope === key,
            open,
          })
        }
        presenter={nativePresenterFor(transport.client)}
        blocked={(rect) =>
          shellStore.state.occlusion.rects.some(
            (r) =>
              r.x < rect.right &&
              r.x + r.width > rect.left &&
              r.y < rect.bottom &&
              r.y + r.height > rect.top
          )
        }
      >
        <SessionStartPage
          key={draft.id}
          workspaceId={workspaceId}
          handoff={async (id, envelope) => {
            const ack = await transport.client.ai.send({
              threadId: id,
              startId: id,
              runId: envelope.runId,
              messages: [
                {
                  id: envelope.messageId,
                  role: "user",
                  parts: envelope.parts.map((part) => ({ ...part })),
                  ...(envelope.userText
                    ? { metadata: { abacus: { userText: envelope.userText } } }
                    : {}),
                },
              ],
              forwardedProps: envelope.forwardedProps,
            });
            if (ack.status === "rejected" || ack.original === "rejected") {
              rejectStartSubmission(id);
              throw new Error(t("chat.composer.rejected"));
            }
          }}
          prefill={(id, text) => updateDraft(id, (d) => ({ ...d, text }))}
          renderComposer={(binding) => (
            <>
              <StartComposer
                key={binding.threadId}
                threadId={binding.threadId}
                runtime={chat}
                context={binding.context}
                config={{
                  mode: "full",
                  pending: binding.pending,
                  placeholder: t("sessions.start.placeholder"),
                  attachmentsBase: binding.root,
                  attachmentContext: binding.attachmentContext,
                  showModeChip: true,
                  model: model.model,
                  availableModes: model.availableModes,
                  defaultMode: prefs.defaultMode,
                  blocked: binding.blocked ? "loading" : model.blocked,
                  mentions: {
                    search: async (query) =>
                      binding.workspaceId
                        ? (
                            await transport.client.files.search({
                              checkout: { workspaceId: binding.workspaceId },
                              query,
                            })
                          ).items.map((item) => item.relativePath)
                        : [],
                  },
                  history: binding.workspaceId
                    ? {
                        list: () =>
                          transport.client.settings.promptHistory.list({
                            scope: draftConversationKey(
                              binding.workspaceId!,
                              draft.id
                            ),
                          }),
                        add: async (prompt) => {
                          await transport.client.settings.promptHistory.add({
                            scope: draftConversationKey(
                              binding.workspaceId!,
                              draft.id
                            ),
                            prompt,
                          });
                        },
                      }
                    : undefined,
                  onSubmitEnvelope: binding.submit,
                }}
              />
            </>
          )}
        />
      </SessionStartResources>
    </>
  );
};
export const Route = createFileRoute("/_shell/(sessions)/sessions/new")({
  validateSearch: NewSessionSearch,
  loaderDeps: ({ search }) => ({
    workspace: search.workspace,
    draft: search.draft,
  }),
  loader: async ({ context, deps, preload }) => {
    const { sessions, workspaces } = context.db.collections;
    await Promise.all([
      sessions.preload(),
      workspaces.preload(),
      // The composer starts a thread through the chat runtime.
      preload ? undefined : context.prepareChat(),
    ]);
    const pickable = [...workspaces.values()].filter(
      (w) => w.status !== "deleted" && (w.kind == null || w.kind === "auto")
    );
    const prefs = context.db.collections.prefs.get("app");
    let workspaceId =
      pickable.find((w) => w.id === deps.workspace)?.id ??
      pickable.find((w) => w.id === prefs?.lastPickedWorkspaceId)?.id ??
      pickable.find((w) => w.kind === "auto")?.id ??
      null;
    if (!workspaceId && !preload) {
      const result =
        await context.transport.client.workspaces.ensureSessionHome({});
      await workspaces.utils.resync();
      workspaceId = result.workspaceId;
    }
    if (!preload) {
      if (deps.draft && deps.draft !== startDraftStore.state.id) {
        const saved = restoreSessionDraft(deps.draft);
        if (saved) startDraftStore.setState(() => saved);
      }
      prepareStartDraft(context.db, workspaceId);
    }
    return { workspaceId, draftId: startDraftStore.state.id };
  },
  component: SessionsNewRoute,
});
