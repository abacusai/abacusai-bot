import { useNavigate } from "@tanstack/react-router";
import { motion } from "framer-motion";
import {
  FoldVertical,
  KeyRound,
  RefreshCw,
  Search,
  Settings2,
  Star,
} from "lucide-react";
import { useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import type { ModelAvailability } from "#shared/models";
import { PROVIDER_KEY_FIELDS } from "#shared/settings";

import { useAbacusAccountQuery } from "../../hooks/use-abacus-account";
import { useWorkspaceStore } from "../../stores/code-store";
import { ProviderKeyDialog } from "../settings/provider-key-dialog";
import { Button } from "../ui";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
} from "../ui/combobox";
import { InputGroupAddon } from "../ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { PremiumUpgradeCard } from "./premium-upgrade-card";
import { ProviderMark } from "./provider-mark";

type RailValue = "favorites" | string;

/**
 * The free-tier dropdown sells its two free upgrades in place: "Connect
 * OpenRouter" and "Connect Google AI Studio" rows under OpenLLM, each gone the
 * moment its provider is connected.
 */
const CONNECT_OPENROUTER_ID = "connect/openrouter";
const CONNECT_GEMINI_ID = "connect/gemini";
const CONNECT_RANK: Record<string, number> = {
  [CONNECT_OPENROUTER_ID]: 0,
  [CONNECT_GEMINI_ID]: 1,
};
/** The Gemini key field, for the dialog the picker opens in place. */
const GEMINI_FIELD = PROVIDER_KEY_FIELDS.find(
  (field) => field.provider === "gemini"
);
const EMPTY_MODELS: ModelAvailability[] = [];
const PROVIDER_LABELS = new Map(
  PROVIDER_KEY_FIELDS.map((field) => [field.provider, field.label])
);

const getProviderLabel = (provider: string): string =>
  PROVIDER_LABELS.get(provider) ??
  provider
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");

const modelProviderGroup = (provider: string): string =>
  provider === "openllm" || provider === "abacus" ? "abacus" : provider;

const modelProviderLabel = (provider: string): string =>
  provider === "abacus" ? "Abacus.AI" : getProviderLabel(provider);

export const ModelPicker = ({
  models,
  selectedModelValue,
  onSelectModel,
  activeWorkspaceId,
  onModelsRefreshed,
  attentionNonce = 0,
}: {
  models: ModelAvailability[] | undefined;
  selectedModelValue: string;
  onSelectModel: (workspaceId: string | null, value: string) => void;
  activeWorkspaceId: string | null;
  onModelsRefreshed?: () => void;
  attentionNonce?: number;
}): JSX.Element => {
  const { t } = useTranslation();
  // Only models that can run right now: a provider whose key was removed takes
  // its models out of the dropdown; offering one fails on the first token.
  const options = useMemo(
    () => (models ?? EMPTY_MODELS).filter((model) => model.configured),
    [models]
  );
  const requestedSelection = options.find(
    (option) => option.id === selectedModelValue
  );
  const selected = requestedSelection ?? options[0];
  const favoriteModelIds = useWorkspaceStore((state) => state.favoriteModelIds);
  const toggleFavoriteModel = useWorkspaceStore(
    (state) => state.toggleFavoriteModel
  );
  const navigate = useNavigate();
  const openProviderSettings = (provider: string): void => {
    if (provider === "*") {
      void navigate({ to: "/settings/models", search: {} });
      return;
    }
    void navigate({
      to: "/settings/models",
      search: { provider },
    });
  };
  const providers = useMemo(() => {
    const groups = [
      ...new Set(options.map((option) => modelProviderGroup(option.provider))),
    ];
    // The product order: Abacus first, then the two pool sources it pairs
    // with, then everything else alphabetically.
    const pinned: Record<string, number> = {
      abacus: 0,
      openrouter: 1,
      gemini: 2,
    };
    return groups.toSorted((left, right) => {
      const pinDelta = (pinned[left] ?? 9) - (pinned[right] ?? 9);
      return (
        pinDelta ||
        modelProviderLabel(left).localeCompare(modelProviderLabel(right))
      );
    });
  }, [options]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  /** The key dialog is open for Gemini. */
  const [connectingGemini, setConnectingGemini] = useState(false);
  const [compact, setCompact] = useState(false);
  const hasConfiguredModel = options.length > 0;
  const [railValue, setRailValue] = useState<RailValue>(
    modelProviderGroup(selected?.provider ?? providers[0] ?? "favorites")
  );

  // The composed catalog's own order, which for Abacus models is the server's
  // tier-shaped lineup (router first, then the platform's deliberate order).
  const catalogIndex = useMemo(
    () => new Map(options.map((option, index) => [option.id, index])),
    [options]
  );

  const { data: abacusAccount } = useAbacusAccountQuery();
  const isFreeTier = abacusAccount?.subscription_tier === "free";
  const openRouterConnected = options.some(
    (option) => option.provider === "openrouter"
  );
  const geminiConnected = options.some(
    (option) => option.provider === "gemini"
  );
  const connectRows = useMemo(() => {
    if (!isFreeTier) return [] as ModelAvailability[];
    const rows: ModelAvailability[] = [];
    if (!openRouterConnected)
      rows.push({
        id: CONNECT_OPENROUTER_ID,
        label: t("workspace.modelPicker.connectOpenRouter"),
        note: t("workspace.modelPicker.connectOpenRouterNote"),
        // Grouped with Abacus so the row sits right under OpenLLM; the rendered
        // mark is the real provider's.
        provider: "abacus",
        tier: "free",
        configured: true,
      });
    if (!geminiConnected)
      rows.push({
        id: CONNECT_GEMINI_ID,
        label: t("workspace.modelPicker.connectGoogleAi"),
        note: t("workspace.modelPicker.connectGoogleAiNote"),
        provider: "abacus",
        tier: "free",
        configured: true,
      });
    // The paid upgrade is the card pinned under the list, not a row.
    return rows;
  }, [geminiConnected, isFreeTier, openRouterConnected, t]);

  const visibleOptions = useMemo(() => {
    // Search crosses the whole catalog (it ignores the compact rail's provider
    // scope) and matches label, id, provider name and note.
    const query = search.trim().toLowerCase();
    const filtered =
      query.length > 0
        ? options.filter((option) =>
            `${option.label} ${option.id} ${modelProviderLabel(
              modelProviderGroup(option.provider)
            )} ${option.note ?? ""}`
              .toLowerCase()
              .includes(query)
          )
        : !compact
          ? [...options, ...connectRows]
          : railValue === "favorites"
            ? options.filter((option) => favoriteModelIds.includes(option.id))
            : [
                ...options.filter(
                  (option) => modelProviderGroup(option.provider) === railValue
                ),
                ...(railValue === "abacus" ? connectRows : []),
              ];
    return filtered.toSorted((left, right) => {
      const providerDelta =
        providers.indexOf(modelProviderGroup(left.provider)) -
        providers.indexOf(modelProviderGroup(right.provider));
      const openLlmDelta =
        Number(right.provider === "openllm") -
        Number(left.provider === "openllm");
      // Right under OpenLLM: the free plan's two connect rows, OpenRouter first.
      const connectDelta =
        Number(right.id in CONNECT_RANK) - Number(left.id in CONNECT_RANK) ||
        (CONNECT_RANK[left.id] ?? 0) - (CONNECT_RANK[right.id] ?? 0);
      const favoriteDelta =
        Number(favoriteModelIds.includes(right.id)) -
        Number(favoriteModelIds.includes(left.id));
      // Abacus entries keep the catalog's product order; others alphabetical.

      const catalogDelta =
        modelProviderGroup(left.provider) === "abacus"
          ? (catalogIndex.get(left.id) ?? 0) - (catalogIndex.get(right.id) ?? 0)
          : 0;
      return (
        providerDelta ||
        openLlmDelta ||
        connectDelta ||
        favoriteDelta ||
        catalogDelta ||
        left.label.localeCompare(right.label)
      );
    });
  }, [
    catalogIndex,
    compact,
    connectRows,
    favoriteModelIds,
    options,
    providers,
    railValue,
    search,
  ]);
  const groupedVisibleOptions = useMemo(() => {
    const groups = new Map<string, ModelAvailability[]>();
    for (const option of visibleOptions) {
      const provider = modelProviderGroup(option.provider);
      const group = groups.get(provider) ?? [];
      group.push(option);
      groups.set(provider, group);
    }
    return [...groups.entries()];
  }, [visibleOptions]);

  if (!hasConfiguredModel) {
    return (
      <motion.div
        key={attentionNonce}
        className="max-w-full min-w-0"
        animate={attentionNonce > 0 ? { x: [0, -5, 5, -3, 3, 0] } : undefined}
        transition={{ duration: 0.32 }}
      >
        <Button
          variant="outline"
          size="sm"
          data-id="local-code-connect-models"
          className="max-w-full"
          onClick={() => openProviderSettings("*")}
        >
          <KeyRound />
          {t("workspace.modelPicker.connectModels")}
        </Button>
      </motion.div>
    );
  }

  return (
    <div className="flex max-w-full min-w-0 items-center gap-0.5">
      <Combobox
        open={open}
        items={visibleOptions}
        filteredItems={visibleOptions}
        filter={null}
        value={selected ?? null}
        itemToStringValue={(option) =>
          `${option.label} ${option.provider} ${option.note ?? ""}`
        }
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setSearch("");
          setOpen(nextOpen);
        }}
        onValueChange={(option) => {
          if (option == null) return;
          if (option.id === CONNECT_OPENROUTER_ID) {
            setOpen(false);
            // The credentials-changed event refreshes the catalog when the hop
            // lands. A failure (not a cancel) falls back to the keys panel.

            void window.api.agent.startOpenRouterAuth().then((result) => {
              if (result.ok === true) {
                void window.api.agent
                  .listModels(true)
                  .then(() => onModelsRefreshed?.());
              } else if (result.cancelled !== true) {
                openProviderSettings("openrouter");
              }
            });
            return;
          }
          if (option.id === CONNECT_GEMINI_ID) {
            setOpen(false);
            // The same key dialog as onboarding and the models page, here in
            // the chat rather than a trip to Settings; it carries the link.
            setConnectingGemini(true);
            return;
          }
          onSelectModel(activeWorkspaceId, option.id);
          setOpen(false);
        }}
      >
        <ComboboxTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              data-id="local-code-model-selector"
              aria-label={selected?.label ?? t("workspace.modelPlaceholder")}
              className="max-w-full min-w-0"
            />
          }
        >
          <ProviderMark
            provider={selected?.provider ?? "local"}
            className="size-4 shrink-0"
          />
          <span className="truncate">
            {selected?.label ?? t("workspace.modelPlaceholder")}
          </span>
        </ComboboxTrigger>
        <ComboboxContent
          side="top"
          align="start"
          className="flex h-[min(24rem,var(--available-height))] w-[min(30rem,calc(100vw-2rem))] max-w-[var(--available-width)] min-w-0 flex-col gap-0 overflow-hidden p-0"
        >
          <div className="flex min-h-0 min-w-0 flex-1">
            {compact && (
              <div className="bg-muted/20 scroll-fade-y scroll-fade-4 scrollbar-autohide flex w-11 shrink-0 flex-col items-center gap-1 overflow-x-hidden overflow-y-auto border-e p-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant={
                          railValue === "favorites" ? "secondary" : "ghost"
                        }
                        size="icon-lg"
                        onClick={() => {
                          setSearch("");
                          setRailValue("favorites");
                        }}
                        aria-label={t("workspace.modelPicker.favorites")}
                        aria-pressed={railValue === "favorites"}
                      />
                    }
                  >
                    <Star
                      className={
                        railValue === "favorites"
                          ? "fill-current"
                          : "text-muted-foreground"
                      }
                    />
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    {t("workspace.modelPicker.favorites")}
                  </TooltipContent>
                </Tooltip>
                {providers.map((provider) => {
                  const label = modelProviderLabel(provider);
                  return (
                    <Tooltip key={provider}>
                      <TooltipTrigger
                        render={
                          <Button
                            variant={
                              railValue === provider ? "secondary" : "ghost"
                            }
                            size="icon-lg"
                            onClick={() => {
                              setSearch("");
                              setRailValue(provider);
                            }}
                            aria-label={label}
                            aria-pressed={railValue === provider}
                          />
                        }
                      >
                        <ProviderMark
                          provider={
                            provider === "abacus" ? "openllm" : provider
                          }
                          className="size-5"
                        />
                      </TooltipTrigger>
                      <TooltipContent side="right">{label}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </div>
            )}

            <div
              className="group/combobox-content bg-muted/40 flex min-w-0 flex-1 flex-col"
              data-empty={visibleOptions.length === 0 ? "" : undefined}
            >
              <div className="flex items-center gap-1 border-b p-2">
                <ComboboxInput
                  autoFocus
                  showTrigger={false}
                  className="h-7 min-w-0 flex-1 border-0 bg-transparent shadow-none"
                  placeholder={t("workspace.modelPicker.search")}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                >
                  <InputGroupAddon>
                    <Search />
                  </InputGroupAddon>
                </ComboboxInput>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        data-id="local-code-model-refresh"
                        aria-label={t("workspace.refreshModels")}
                        onClick={() => {
                          void window.api.agent
                            .listModels(true)
                            .then(() => onModelsRefreshed?.());
                        }}
                      />
                    }
                  >
                    <RefreshCw />
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {t("workspace.refreshModels")}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        data-id="local-code-model-settings"
                        aria-label={t(
                          "workspace.modelPicker.configureProviders"
                        )}
                        onClick={() => {
                          setOpen(false);
                          openProviderSettings("*");
                        }}
                      />
                    }
                  >
                    <Settings2 />
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {t("workspace.modelPicker.configureProviders")}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant={compact ? "secondary" : "ghost"}
                        size="icon-sm"
                        aria-label={t("workspace.modelPicker.compact")}
                        aria-pressed={compact}
                        onClick={() => setCompact((value) => !value)}
                      />
                    }
                  >
                    <FoldVertical />
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {t("workspace.modelPicker.compact")}
                  </TooltipContent>
                </Tooltip>
              </div>
              <ComboboxList className="scroll-fade-y scroll-fade-6 max-h-none min-h-0 flex-1 p-1.5">
                {groupedVisibleOptions.map(([provider, providerOptions]) => (
                  <ComboboxGroup key={provider}>
                    <ComboboxLabel className="bg-popover/95 sticky top-0 z-10 px-2 py-1 text-[0.625rem] font-medium backdrop-blur-sm">
                      {modelProviderLabel(provider)}
                    </ComboboxLabel>
                    {providerOptions.map((option) => {
                      const favorite = favoriteModelIds.includes(option.id);
                      return (
                        <ComboboxItem
                          key={option.id}
                          value={option}
                          className="data-selected:bg-primary/10 data-selected:text-foreground min-h-9 items-start py-1.5 pe-20 [&>span:last-child]:hidden"
                          data-id={`local-code-model-option-${option.id}`}
                        >
                          <ProviderMark
                            provider={
                              option.id === CONNECT_OPENROUTER_ID
                                ? "openrouter"
                                : option.id === CONNECT_GEMINI_ID
                                  ? "gemini"
                                  : option.provider
                            }
                            className="mt-0.5 size-4 shrink-0"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">
                              {option.label}
                            </span>
                            <span className="text-muted-foreground block truncate text-xs">
                              {option.note ?? option.provider}
                            </span>
                          </span>
                          {option.id in CONNECT_RANK ? (
                            <span className="text-muted-foreground absolute end-2 top-1.5 flex h-6 items-center text-xs">
                              <KeyRound className="size-3.5" />
                            </span>
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="absolute end-2 top-1.5"
                              aria-label={t(
                                favorite
                                  ? "workspace.modelPicker.removeFavorite"
                                  : "workspace.modelPicker.addFavorite",
                                { model: option.label }
                              )}
                              onPointerDown={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                              }}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                toggleFavoriteModel(option.id);
                              }}
                            >
                              <Star
                                className={
                                  favorite ? "fill-current" : undefined
                                }
                              />
                            </Button>
                          )}
                        </ComboboxItem>
                      );
                    })}
                  </ComboboxGroup>
                ))}
              </ComboboxList>
              {isFreeTier && (
                <div className="border-t p-1.5">
                  <PremiumUpgradeCard
                    dataId="model-picker-upgrade-card"
                    onBeforeOpen={() => setOpen(false)}
                  />
                </div>
              )}
              <ComboboxEmpty className="flex-1 flex-col items-center gap-2 px-6">
                {search.trim().length === 0 && railValue === "favorites" ? (
                  <>
                    <span className="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-full">
                      <Star className="size-4" />
                    </span>
                    <span className="text-foreground font-medium">
                      {t("workspace.modelPicker.favorites")}
                    </span>
                    <span>{t("workspace.modelPicker.noFavorites")}</span>
                  </>
                ) : (
                  t("workspace.modelPicker.noResults")
                )}
              </ComboboxEmpty>
            </div>
          </div>
        </ComboboxContent>
      </Combobox>
      <ProviderKeyDialog
        field={GEMINI_FIELD ?? null}
        open={connectingGemini}
        onClose={() => setConnectingGemini(false)}
        onSaved={() => onModelsRefreshed?.()}
      />
    </div>
  );
};
