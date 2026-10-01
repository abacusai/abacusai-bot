import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { usePrefs } from "#renderer/data/db/prefs";
import { StartComposer, updateDraft } from "#renderer/features/chat";
import {
  SessionStartPage,
  SessionStartResources,
  useSessionComposerModel,
} from "#renderer/features/sessions";
import {
  TopBarSlot,
  registerPreviewConsumer,
  nativePresenterFor,
  shellStore,
} from "#renderer/features/shell";
import { NewSessionSearch } from "#renderer/lib/navigation/search";
import { Button } from "#renderer/ui/button";
import { draftConversationKey } from "#shared/conversation-scope";
const SessionsNewRoute = () => {
  const { t } = useTranslation();
  const { transport, chat } = Route.useRouteContext();
  const { workspaceId } = Route.useLoaderData();
  const model = useSessionComposerModel();
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
          workspaceId={workspaceId}
          handoff={(id, envelope) =>
            updateDraft(id, (d) => ({ ...d, pendingSubmit: envelope }))
          }
          prefill={(id, text) => updateDraft(id, (d) => ({ ...d, text }))}
          renderComposer={(binding) => (
            <>
              {model.blocked === "no-model" ? (
                <Button onClick={model.onBlocked}>
                  {t("sessions.model.configure")}
                </Button>
              ) : null}
              <StartComposer
                threadId={binding.threadId}
                runtime={chat}
                context={binding.context}
                config={{
                  mode: "full",
                  placeholder: t("sessions.start.placeholder"),
                  attachmentsBase: binding.root,
                  showModeChip: true,
                  model: model.model,
                  onBlocked: model.onBlocked,
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
            </>
          )}
        />
      </SessionStartResources>
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
