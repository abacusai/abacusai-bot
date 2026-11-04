import { OPENLLM_ID, resolveConfiguredModel } from "@abacus-ai/contract/models";
import { useQuery } from "@tanstack/react-query";
import { Lock, Settings2 } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  ConnectorMark,
  markForProvider,
} from "#renderer/components/connector-mark";
import { ModelSetupPopover } from "#renderer/components/model-setup/setup-list";
import { useModelSetup } from "#renderer/components/model-setup/use-model-setup";
import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { accountTier } from "#renderer/lib/credits";
import { useMotionPreference } from "#renderer/lib/motion";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { requestPlanDialog } from "#renderer/lib/upgrade-dialog";
import { useAccount } from "#renderer/lib/use-account";
import { Button } from "#renderer/ui/button";
import { Input } from "#renderer/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "#renderer/ui/popover";

import { botsQueries } from "../data/queries";
import { useBotsTransport } from "../data/transport";
import {
  botModelGroups,
  effectiveModelLabel,
  otherProviderModel,
  toggleFavorite,
} from "./model-groups";
export const useBotModelBinding = (
  value: string | null,
  onChange: (value: string | null) => void,
  layoutId?: string,
  /** Null is the plan's default, not the stored one: a routine's model. */
  { planDefault = false }: { planDefault?: boolean } = {}
) => {
  const { t } = useTranslation();
  const motion = useMotionPreference();
  const transport = useBotsTransport();
  const prefs = usePrefs();
  const navigate = useAppNavigate();
  const queries = botsQueries(transport.orpc);
  const models = useQuery(queries.models());
  const settings = useQuery(queries.settings());
  const catalog = models.data ?? [];
  const defaultModel = planDefault ? undefined : settings.data?.defaultModel;
  const defaultLabel = t(
    planDefault ? "routines.model.planDefault" : "bots.form.modelDefault"
  );
  const account = useAccount();
  const groups = botModelGroups({
    models: catalog,
    favorites: prefs.models.favoriteModelIds,
    defaultModel,
    freeTier: accountTier(account.data) === "free",
    labels: {
      defaultGroup: t("bots.model.default"),
      appDefault: defaultLabel,
      favorites: t("bots.model.favorites"),
      connectOpenRouter: t("bots.model.connectOpenRouter"),
      connectSource: (provider) =>
        t("onboarding.setupKeyDialogTitle", { provider }),
      connectGoogleAi: t("bots.model.connectGoogleAi"),
      tierFree: t("bots.model.free"),
      tierLocal: t("bots.model.local"),
      includedIn: (plan) =>
        plan == null
          ? t("chat.composer.includedInPaid")
          : t("chat.composer.includedIn", { plan }),
    },
    onUpgrade: () => requestPlanDialog("model_locked"),
    onConnect: (provider) =>
      void navigate({
        to: "/settings/models",
        search: (previous) => ({ ...previous, provider }),
      }),
  });
  const other = otherProviderModel(value, defaultModel, catalog);
  const setup = useModelSetup({
    models: catalog,
    loading: models.isPending || settings.isPending,
    failed: models.isError || settings.isError,
    select: onChange,
  });
  const effectiveId = resolveConfiguredModel({
    requested: value,
    defaultModel,
    catalog,
  });
  return {
    setup,
    value,
    /** The catalog row `value` runs on now, if any. */
    effective: catalog.find((model) => model.id === effectiveId) ?? null,
    onConfigureProviders: () =>
      void navigate({ to: "/settings/models", transition: "settings-in" }),
    ...(accountTier(account.data) === "free"
      ? { onUpgrade: () => requestPlanDialog("model_locked") }
      : {}),
    ...(other != null && accountTier(account.data) === "free"
      ? {
          otherProvider: {
            ...other,
            model: other.label,
            onSwitch: () => onChange(OPENLLM_ID),
          },
        }
      : {}),
    label: effectiveModelLabel(value, defaultModel, catalog) ?? defaultLabel,
    onChange,
    groups,
    ...(layoutId && motion === "full" ? { layoutId } : {}),
  };
};
export const ModelPicker = ({
  binding,
}: {
  binding: ReturnType<typeof useBotModelBinding>;
}) => {
  const { t } = useTranslation();
  const db = useDb();
  const navigate = useAppNavigate();
  const prefs = usePrefs();
  const pref = useMotionPreference();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  if (binding.setup.status !== "ready")
    return (
      <ModelSetupPopover
        setup={binding.setup}
        open={open}
        onOpenChange={setOpen}
        connected={() => {}}
      >
        <Button
          variant="secondary"
          aria-label={t("chat.modelSetup.unset")}
          className="max-w-full min-w-0 shrink justify-start"
        >
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-[var(--chat-status-attention)]"
          />
          {t("chat.modelSetup.choose")}
        </Button>
      </ModelSetupPopover>
    );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="secondary"
            className="max-w-full min-w-0 shrink justify-start overflow-hidden"
          />
        }
      >
        <motion.span
          data-slot="bot-model-value"
          className="min-w-0 truncate"
          title={binding.label}
          layoutId={pref === "full" ? binding.layoutId : undefined}
        >
          {binding.value === null ? t("bots.form.modelDefault") : binding.label}
        </motion.span>
      </PopoverTrigger>
      <PopoverContent className="w-[min(360px,var(--available-width))] rounded-[14px] p-1.5 [&_button]:h-8">
        <Input
          aria-label={t("bots.model.search")}
          placeholder={t("bots.model.search")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {binding.groups.map((group) => (
          <div key={group.id} className="py-2">
            <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
              {/* A provider group carries the provider's mark. */}
              {markForProvider(group.id) != null && (
                <ConnectorMark id={markForProvider(group.id)!} size={16} />
              )}
              <span className="min-w-0 truncate">{group.label}</span>
            </p>
            {group.items
              .filter((item) =>
                `${item.label} ${item.id} ${item.description ?? ""} ${group.label}`
                  .toLowerCase()
                  .includes(search.toLowerCase())
              )
              .map((item) =>
                item.locked != null ? (
                  <Button
                    key={item.id}
                    variant="ghost"
                    data-locked
                    className="text-muted-foreground w-full min-w-0 justify-start"
                    onClick={() => {
                      setOpen(false);
                      item.locked!.onSelect();
                    }}
                  >
                    <Lock aria-hidden className="size-3" />
                    <span className="min-w-0 truncate">{item.label}</span>
                    <span className="text-xs">{item.locked.label}</span>
                    <span className="text-primary text-xs font-medium">
                      {t("creditsCard.cta")}
                    </span>
                  </Button>
                ) : (
                  <div key={item.id} className="flex items-center">
                    <Button
                      variant="ghost"
                      className="min-w-0 flex-1 justify-start"
                      aria-pressed={(binding.value ?? "") === item.id}
                      onClick={() => {
                        binding.onChange(item.id || null);
                        setOpen(false);
                      }}
                    >
                      {item.label}
                      <span className="text-muted-foreground text-xs">
                        {item.description}
                      </span>
                    </Button>
                    {item.id && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("bots.model.favorite", {
                          name: item.label,
                        })}
                        aria-pressed={prefs.models.favoriteModelIds.includes(
                          item.id
                        )}
                        onClick={() =>
                          void db.updatePrefs({
                            models: {
                              favoriteModelIds: toggleFavorite(
                                prefs.models.favoriteModelIds,
                                item.id
                              ),
                            },
                          })
                        }
                      >
                        ☆
                      </Button>
                    )}
                  </div>
                )
              )}
            {group.connect && (
              <Button variant="ghost" onClick={group.connect.onSelect}>
                {group.connect.label}
              </Button>
            )}
          </div>
        ))}
        <Button
          variant="ghost"
          className="bg-popover sticky bottom-0 h-8 w-full justify-start rounded-lg border-t text-xs"
          onClick={() => {
            setOpen(false);
            void navigate({
              to: "/settings/models",
              transition: "settings-in",
            });
          }}
        >
          <Settings2 aria-hidden />
          {t("bots.model.configureProviders")}
        </Button>
      </PopoverContent>
    </Popover>
  );
};
