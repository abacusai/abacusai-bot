import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { confirmFreePoolModel } from "#renderer/components/credits-card/actions";
import {
  botModelGroups,
  effectiveModelLabel,
} from "#renderer/components/model-groups";
import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { AgentMode } from "@abacus-ai/contract/agent-types";
import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import { resolveConfiguredModel } from "@abacus-ai/contract/models";

import { useCheckoutQueries, useSessionsTransport } from "./queries";
import { setSessionModel } from "./session-actions";
export const useSessionComposerModel = (row?: SessionRow) => {
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
  const value = row?.model ?? draftModel;
  const selected = resolveConfiguredModel({
    requested: value,
    defaultModel: settings.data?.defaultModel,
    catalog: models,
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
    onBlocked: () =>
      void navigate({ to: "/settings/models", transition: "nav-lateral" }),
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
      catalog.isPending || settings.isPending
        ? ("loading" as const)
        : selected === null
          ? ("no-model" as const)
          : undefined,
    model: {
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
          } as never),
      }),
      onChange: (id: string | null) => {
        if (!row) {
          setDraftModel(id);
          return;
        }
        if (id)
          void setSessionModel(db, transport.client, row, id).catch((e) =>
            setError(String(e))
          );
        else
          void db.collections.sessions.update(row.id, (d) => {
            d.model = null;
          }).isPersisted.promise;
      },
    },
  };
};
