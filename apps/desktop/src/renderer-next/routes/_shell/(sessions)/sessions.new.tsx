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
    const requested = deps.workspace ?? prefs?.lastPickedWorkspaceId;
    let workspaceId =
      pickable.find((w) => w.id === requested)?.id ??
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
