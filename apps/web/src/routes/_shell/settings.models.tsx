import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { adoptDraftModel } from "#renderer/features/chat/composer/draft-store";
import { ModelsPage } from "#renderer/features/settings/models";
import { ModelsSearch } from "#renderer/features/settings/search";
import { shellStore } from "#renderer/features/shell/shell-store";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";

const ModelsSettingsRoute = () => {
  const { t } = useTranslation();
  const { db, transport } = Route.useRouteContext();
  const navigate = useAppNavigate();
  const adoptModel = async (target: string, model: string) => {
    if (target.startsWith("draft:")) {
      adoptDraftModel(target.slice(6), model);
      const location = shellStore.state.lastLocationOutsideSettings;
      await navigate({
        ...location,
        to: location.pathname,
        transition: "settings-out",
        // A location remembered at runtime.
      } as never);
      return;
    }
    if (!target.startsWith("session:"))
      throw new Error(t("phase5.draftModelUnavailable"));
    const id = target.slice(8);
    const row = db.collections.sessions.get(id);
    if (!row) throw new Error(t("phase5.threadGone"));
    const tx = row.owner
      ? db.collections.bots.update(row.owner.botId, (draft) => {
          draft.model = model;
        })
      : db.collections.sessions.update(id, (draft) => {
          draft.model = model;
        });
    await tx.isPersisted.promise;
    if (row.status === "running")
      await transport.client.agent.setModel({
        workspaceId: row.workspaceId,
        sessionId: id,
        model,
      });
    if (row.routineId)
      await navigate({
        to: "/routines/$routineId",
        params: { routineId: row.routineId },
        search: { run: id },
        transition: "settings-out",
      });
    else if (row.owner?.role === "forever")
      await navigate({
        to: "/bots/$botId",
        params: { botId: row.owner.botId },
        transition: "settings-out",
      });
    else if (row.owner)
      await navigate({
        to: "/bots/$botId/chats/$sessionId",
        params: { botId: row.owner.botId, sessionId: id },
        transition: "settings-out",
      });
    else
      await navigate({
        to: "/sessions/$sessionId",
        params: { sessionId: id },
        transition: "settings-out",
      });
  };
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("settings.pages.models")}
        </span>
      </TopBarSlot>
      <ModelsPage adoptModel={adoptModel} />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/models")({
  validateSearch: ModelsSearch,
  component: ModelsSettingsRoute,
});
