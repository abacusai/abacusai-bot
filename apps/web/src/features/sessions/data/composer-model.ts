import { AgentMode } from "@abacus-ai/contract/agent-types";
import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import { resolveConfiguredModel } from "@abacus-ai/contract/models";
import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { confirmFreePoolModel } from "#renderer/components/credits-card/actions";
import {
  botModelGroups,
  effectiveModelLabel,
} from "#renderer/components/model-groups";
import { useModelSetup } from "#renderer/components/model-setup/use-model-setup";
import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import {
  draftStore,
  updateDraft,
} from "#renderer/features/chat/composer/draft-store";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";

import { useCheckoutQueries, useSessionsTransport } from "./queries";
import { setSessionModel } from "./session-actions";
export const useSessionComposerModel = (row?: SessionRow, draftId?: string) => {
  const { t } = useTranslation();
  const db = useDb();
  const prefs = usePrefs();
  const transport = useSessionsTransport();
  const navigate = useAppNavigate();
  const options = useCheckoutQueries({
    workspaceId: row?.workspaceId ?? "none",
    sessionId: row?.id,
  });
  const catalog = useQuery(options.models());
  const settings = useQuery(options.settings());
  const sandbox = useQuery(options.sandbox());
  const checkout = useQuery({
    ...options.checkoutStatus({
      workspaceId: row?.workspaceId ?? "none",
      sessionId: row?.id,
    }),
    enabled: !!row,
  });
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const models = catalog.data ?? [];
  const savedModel = useSelector(draftStore, (state) =>
    draftId ? state[draftId]?.model : undefined
  );
  const value = row?.model ?? (draftId ? savedModel : draftModel) ?? null;
  const selected = resolveConfiguredModel({
    requested: value,
    defaultModel: settings.data?.defaultModel,
    catalog: models,
  });
  const changeModel = (id: string | null) => {
    if (!row) {
      if (draftId) updateDraft(draftId, (d) => ({ ...d, model: id }));
      else setDraftModel(id);
      return;
    }
    if (id)
      void setSessionModel(db, transport.client, row, id).catch((e) =>
        setError(String(e))
      );
    else
      void db.collections.sessions
        .update(row.id, (d) => {
          d.model = null;
        })
        .isPersisted.promise.catch((e) => setError(String(e)));
  };
  const setup = useModelSetup({
    models,
    loading: catalog.isPending || settings.isPending,
    failed: catalog.isError || settings.isError,
    select: changeModel,
  });
  return {
    error,
    onResumeOnFreePool: async () => {
      if (!row) return;
      await setSessionModel(db, transport.client, row, "abacus/openllm");
      if (row.status === "running")
        await confirmFreePoolModel(transport, {
          workspaceId: row.workspaceId,
          sessionId: row.id,
        });
    },
    missing: checkout.data?.exists === false,
    availableModes: sandbox.data?.available
      ? [
          AgentMode.Normal,
          AgentMode.AcceptEdits,
          AgentMode.PlanMode,
          AgentMode.Yolo,
          AgentMode.Auto,
        ]
      : [
          AgentMode.Normal,
          AgentMode.AcceptEdits,
          AgentMode.PlanMode,
          AgentMode.Yolo,
        ],
    blocked:
      setup.status === "error"
        ? ("error" as const)
        : catalog.isPending || settings.isPending
          ? ("loading" as const)
          : selected === null
            ? ("no-model" as const)
            : undefined,
    model: {
      setup,
      onConfigureProviders: () =>
        void navigate({ to: "/settings/models", transition: "settings-in" }),
      value,
      label:
        effectiveModelLabel(value, settings.data?.defaultModel, models) ??
        t("sessions.model.choose"),
      groups: botModelGroups({
        models,
        favorites: prefs.models.favoriteModelIds,
        defaultModel: settings.data?.defaultModel,
        freeTier: false,
        labels: {
          defaultGroup: t("sessions.model.default"),
          appDefault: t("sessions.model.appDefault"),
          favorites: t("sessions.model.favorites"),
          localProvider: t("sessions.model.local"),
          connectOpenRouter: t("sessions.model.connectOpenRouter"),
          connectGoogleAi: t("sessions.model.connectGoogleAi"),
          tierFree: t("sessions.model.free"),
          tierLocal: t("sessions.model.local"),
        },
        onConnect: (provider) =>
          void navigate({
            to: "/settings/models",
            search: { provider },
            transition: "nav-lateral",
          }),
      }),
      onChange: changeModel,
    },
  };
};
