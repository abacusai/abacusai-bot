import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { usePrefs } from "#next/data/db/prefs";
import {
  chatRuntimeFor,
  StartComposer,
  updateDraft,
} from "#next/features/chat";
import {
  SessionStartPage,
  useSessionComposerModel,
} from "#next/features/sessions";
import { TopBarSlot } from "#next/features/shell";
import { NewSessionSearch } from "#next/lib/navigation/search";
import { draftConversationKey } from "#shared/conversation-scope";
const SessionsNewRoute = () => {
  const { t } = useTranslation();
  const { transport } = Route.useRouteContext();
  const { workspaceId } = Route.useLoaderData();
  const model = useSessionComposerModel();
  const prefs = usePrefs();
  return (
    <>
      <TopBarSlot>
        <span className="font-medium">{t("sessions.page.newTitle")}</span>
      </TopBarSlot>
      <SessionStartPage
        workspaceId={workspaceId}
        handoff={(id, envelope) =>
          updateDraft(id, (d) => ({ ...d, pendingSubmit: envelope }))
        }
        prefill={(id, text) => updateDraft(id, (d) => ({ ...d, text }))}
        renderComposer={(binding) => (
          <StartComposer
            threadId={binding.threadId}
            runtime={chatRuntimeFor(transport)}
            context={binding.context}
            config={{
              mode: "full",
              placeholder: t("sessions.start.placeholder"),
              attachmentsBase: binding.root,
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
                        scope: draftConversationKey(binding.workspaceId!),
                      }),
                    add: async (prompt) => {
                      await transport.client.settings.promptHistory.add({
                        scope: draftConversationKey(binding.workspaceId!),
                        prompt,
                      });
                    },
                  }
                : undefined,
              onSubmitEnvelope: binding.submit,
            }}
          />
        )}
      />
    </>
  );
};
export const Route = createFileRoute("/_shell/(sessions)/sessions/new")({
  validateSearch: NewSessionSearch,
  loaderDeps: ({ search }) => ({ workspace: search.workspace }),
  loader: async ({ context, deps, preload }) => {
    const { sessions, workspaces } = context.db.collections;
    await Promise.all([sessions.preload(), workspaces.preload()]);
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
    return { workspaceId };
  },
  component: SessionsNewRoute,
});
