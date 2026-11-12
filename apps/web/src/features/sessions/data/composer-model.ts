import { AgentMode } from "@abacus-ai/contract/agent-types";
import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import {
  ABACUS_CODE_ROUTER_LOW_ID,
  OPENLLM_ID,
  resolveConfiguredModel,
} from "@abacus-ai/contract/models";
import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { confirmFreePoolModel } from "#renderer/components/credits-card/actions";
import {
  botModelGroups,
  chatModelChip,
  otherProviderModel,
} from "#renderer/components/model-groups";
import { useModelSetup } from "#renderer/components/model-setup/use-model-setup";
import { useDb } from "#renderer/data/db";
import { isListedSession, isListedWorkspace } from "#renderer/data/db/filters";
import { usePrefs } from "#renderer/data/db/prefs";
import {
  draftStore,
  updateDraft,
} from "#renderer/lib/continuity/composer-drafts";
import { accountTier, creditsTier } from "#renderer/lib/credits";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { showError } from "#renderer/lib/toast";
import { requestPlanDialog } from "#renderer/lib/upgrade-dialog";
import { useCreditsAccount } from "#renderer/lib/use-credits-account";

import { continueInNewChat } from "./continue-chat";
import { useCheckoutQueries, useSessionsTransport } from "./queries";
import { setSessionModel } from "./session-actions";
/** The low-cost lanes a paying plan can run on; the top-model hint offers a step up from them. */
const LOW_COST_LANES = new Set<string>([ABACUS_CODE_ROUTER_LOW_ID, OPENLLM_ID]);

export const useSessionComposerModel = (
  row?: SessionRow,
  draftId?: string,
  draftWorkspaceId?: string | null
) => {
  const { t } = useTranslation();
  const db = useDb();
  const prefs = usePrefs();
  const transport = useSessionsTransport();
  const navigate = useAppNavigate();
  const account = useCreditsAccount();
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
  const models = catalog.data ?? [];
  const savedModel = useSelector(draftStore, (state) =>
    draftId ? state[draftId]?.model : undefined
  );
  const value =
    row?.model ??
    (draftId
      ? savedModel !== undefined
        ? savedModel
        : (prefs.models.perWorkspace[draftWorkspaceId ?? ""] ?? null)
      : draftModel) ??
    null;
  const selected = resolveConfiguredModel({
    requested: value,
    defaultModel: settings.data?.defaultModel,
    catalog: models,
  });
  // A refused or unsaved switch is said out loud; the chat stays on its model.
  const failed = () => showError(t("workspace.modelSwitchFailed"));
  const changeModel = (id: string | null) => {
    if (!row) {
      if (draftId) updateDraft(draftId, (d) => ({ ...d, model: id }));
      else setDraftModel(id);
      return;
    }
    if (id) void setSessionModel(db, transport.client, row, id).catch(failed);
    else
      void db.collections.sessions
        .update(row.id, (d) => {
          d.model = null;
        })
        .isPersisted.promise.catch(failed);
  };
  const chip = chatModelChip(
    row?.model,
    value,
    settings.data?.defaultModel,
    models
  );
  // An unavailable pin runs as is: no other model to name in its place.
  const other = chip?.unavailable
    ? null
    : otherProviderModel(value, settings.data?.defaultModel, models);
  // A paying plan on a low-cost lane (RouteLLM - Open, Basic's default, or
  // the low code router): the composer offers its top models.
  const tier = creditsTier(account.data);
  const topModels =
    (tier === "basic" || tier === "paid") &&
    LOW_COST_LANES.has(value ?? selected ?? "")
      ? { tier: accountTier(account.data) ?? tier }
      : null;
  const workspace = row ? db.collections.workspaces.get(row.workspaceId) : null;
  const listedWorkspace = workspace != null && isListedWorkspace(workspace);
  const setup = useModelSetup({
    models,
    loading: catalog.isPending || settings.isPending,
    failed: catalog.isError || settings.isError,
    select: changeModel,
  });
  return {
    onResumeOnFreePool: async () => {
      if (!row) return;
      await setSessionModel(db, transport.client, row, OPENLLM_ID);
      if (row.status === "running")
        await confirmFreePoolModel(transport, {
          workspaceId: row.workspaceId,
          sessionId: row.id,
        });
    },
    onResumeOnModel: async (id: string) => {
      if (row) await setSessionModel(db, transport.client, row, id);
    },
    onSwitchThisChat: async (id: string) => {
      if (row) {
        await setSessionModel(db, transport.client, row, id, {
          thisChatOnly: true,
        });
        if (row.status === "running" && id === OPENLLM_ID)
          await confirmFreePoolModel(transport, {
            workspaceId: row.workspaceId,
            sessionId: row.id,
          });
      }
      return "chat" as const;
    },
    // A listed chat only: a bot's chats and routine runs keep their model.
    ...(row != null && isListedSession(row) && listedWorkspace
      ? {
          onContinueInNewChat: (id: string, prompt?: string) =>
            continueInNewChat({
              client: transport.client,
              row,
              model: id,
              ...(prompt != null ? { prompt } : {}),
              open: (search) =>
                navigate({
                  to: "/sessions/new",
                  search,
                  transition: "nav-forward",
                }),
            }),
        }
      : {}),
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
      ...(creditsTier(account.data) === "free"
        ? { onUpgrade: () => requestPlanDialog("model_locked") }
        : {}),
      ...(other != null && creditsTier(account.data) === "free"
        ? {
            otherProvider: {
              ...other,
              model: other.label,
              onSwitch: () => changeModel(OPENLLM_ID),
            },
          }
        : {}),
      ...(topModels != null ? { topModels } : {}),
      value,
      resolved: selected,
      label: chip?.label ?? t("sessions.model.choose"),
      unavailable: chip?.unavailable === true,
      groups: botModelGroups({
        models,
        favorites: prefs.models.favoriteModelIds,
        defaultModel: settings.data?.defaultModel,
        freeTier: false,
        labels: {
          defaultGroup: t("sessions.model.default"),
          appDefault: t("sessions.model.appDefault"),
          favorites: t("sessions.model.favorites"),
          connectOpenRouter: t("sessions.model.connectOpenRouter"),
          connectGoogleAi: t("sessions.model.connectGoogleAi"),
          tierFree: t("sessions.model.free"),
          tierLocal: t("sessions.model.local"),
          includedIn: (plan) =>
            plan == null
              ? t("chat.composer.includedInPaid")
              : t("chat.composer.includedIn", { plan }),
        },
        onUpgrade: () => requestPlanDialog("model_locked"),
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
