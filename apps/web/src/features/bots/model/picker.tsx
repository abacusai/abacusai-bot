import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  ConnectorMark,
  markForProvider,
} from "#renderer/components/connector-mark";
import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { useMotionPreference } from "#renderer/lib/motion";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { Button } from "#renderer/ui/button";
import { Input } from "#renderer/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "#renderer/ui/popover";

import { botsQueries } from "../data/queries";
import { useBotsTransport } from "../data/transport";
import {
  botModelGroups,
  effectiveModelLabel,
  toggleFavorite,
} from "./model-groups";
export const useBotModelBinding = (
  value: string | null,
  onChange: (value: string | null) => void,
  layoutId?: string
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
  const account = useQuery(queries.account());
  const groups = botModelGroups({
    models: catalog,
    favorites: prefs.models.favoriteModelIds,
    defaultModel: settings.data?.defaultModel,
    freeTier:
      (account.data?.subscription_tier ?? account.data?.plan)?.toLowerCase() ===
      "free",
    labels: {
      defaultGroup: t("bots.model.default"),
      appDefault: t("bots.form.modelDefault"),
      favorites: t("bots.model.favorites"),
      localProvider: t("bots.model.local"),
      connectOpenRouter: t("bots.model.connectOpenRouter"),
      connectSource: (provider) =>
        t("onboarding.setupKeyDialogTitle", { provider }),
      connectGoogleAi: t("bots.model.connectGoogleAi"),
      tierFree: t("bots.model.free"),
      tierLocal: t("bots.model.local"),
    },
    onConnect: (provider) =>
      void navigate({
        to: "/settings/models",
        search: (previous) => ({ ...previous, provider }),
      }),
  });
  return {
    value,
    label:
      effectiveModelLabel(value, settings.data?.defaultModel, catalog) ??
      t("bots.form.modelDefault"),
    onChange,
    groups,
    ...(layoutId && motion === "full" ? { layoutId } : {}),
  };
};
export const ModelPicker = ({
  binding,
  readOnly = false,
}: {
  binding: ReturnType<typeof useBotModelBinding>;
  readOnly?: boolean;
}) => {
  const { t } = useTranslation();
  const db = useDb();
  const prefs = usePrefs();
  const pref = useMotionPreference();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  if (readOnly)
    return (
      <span className="min-w-0 truncate" title={binding.label}>
        {binding.value === null ? t("bots.form.modelDefault") : binding.label}
      </span>
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
      <PopoverContent className="max-h-[min(384px,var(--available-height))] w-[min(360px,var(--available-width))] overflow-auto">
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
              .map((item) => (
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
              ))}
            {group.connect && (
              <Button variant="ghost" onClick={group.connect.onSelect}>
                {group.connect.label}
              </Button>
            )}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
};
