/**
 * The bot model picker's groups (spec 03 §13.1, parity P70): the old
 * composer picker's grouping, order and search rules
 * (`renderer/components/chat/model-picker.tsx`) as data for the chat kit's
 * picker shell. Pure: labels and the connect action come in as arguments.
 *
 * The kit's `ModelGroup` is declared structurally here (features never import
 * each other); the route hands these groups to `ModelChipBinding.groups`. In
 * the kit, App default is the item whose `id` is `""`: selecting it calls
 * `onChange(null)`, and it is checked while the binding's `value` is null.
 */
import { FREE_POOL_PROVIDERS, type FreePoolProvider } from "#shared/free-pool";
import { LOCAL_PROVIDER_ID } from "#shared/local-models";
import { resolveConfiguredModel, type ModelAvailability } from "#shared/models";
import { PROVIDER_KEY_FIELDS } from "#shared/settings";

/** Structurally the chat kit's `ModelGroup` (features/chat/kit/context.tsx). */
export interface BotModelGroup {
  id: string;
  label: string;
  items: Array<{ id: string; label: string; description?: string }>;
  connect?: { label: string; onSelect(): void };
}

/** The kit's id for the App default item (`onChange(null)`). */
export const APP_DEFAULT_ITEM_ID = "";

type FreeProvider = FreePoolProvider;

export interface BotModelLabels {
  /** "Default" */
  defaultGroup: string;
  /** "App default" */
  appDefault: string;
  /** "Favorites" */
  favorites: string;
  /** "On this machine" (the local provider's group). */
  localProvider: string;
  connectOpenRouter: string;
  connectGoogleAi: string;
  connectSource?: (provider: FreeProvider) => string;
  /** Tier badges shown as the item's description ("Free", "Local"). */
  tierFree: string;
  tierLocal: string;
}

const PROVIDER_LABELS = new Map(
  PROVIDER_KEY_FIELDS.map((field) => [field.provider, field.label])
);

/** abacus and openllm share one group, as in the old picker. */
const modelProviderGroup = (provider: string): string =>
  provider === "openllm" || provider === "abacus" ? "abacus" : provider;

const modelProviderLabel = (provider: string, localLabel: string): string => {
  if (provider === LOCAL_PROVIDER_ID) return localLabel;
  if (provider === "abacus") return "Abacus.AI";
  return (
    PROVIDER_LABELS.get(provider) ??
    provider
      .split(/[-_]/u)
      .filter(Boolean)
      .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
      .join(" ")
  );
};

/** The product order: Abacus, then OpenRouter, Gemini, then alphabetical. */
const PINNED_PROVIDERS: Record<string, number> = {
  abacus: 0,
  openrouter: 1,
  gemini: 2,
};

const byProvider =
  (localLabel: string) =>
  (left: string, right: string): number =>
    (PINNED_PROVIDERS[left] ?? 9) - (PINNED_PROVIDERS[right] ?? 9) ||
    modelProviderLabel(left, localLabel).localeCompare(
      modelProviderLabel(right, localLabel)
    );

/** What the old picker's search matched: label, id, provider name, note. */
export const modelSearchText = (
  model: ModelAvailability,
  localLabel: string
): string =>
  `${model.label} ${model.id} ${modelProviderLabel(
    modelProviderGroup(model.provider),
    localLabel
  )} ${model.note ?? ""}`.toLowerCase();

/** The label of the model `resolveConfiguredModel` picks, or null. */
export const effectiveModelLabel = (
  botModel: string | null,
  defaultModel: string | null | undefined,
  catalog: readonly ModelAvailability[]
): string | null => {
  const id = resolveConfiguredModel({
    requested: botModel,
    defaultModel,
    catalog,
  });
  return id == null
    ? null
    : (catalog.find((model) => model.id === id)?.label ?? id);
};

/** What App default resolves to now ("RouteLLM" …), or null. */
export const appDefaultLabel = (
  defaultModel: string | null | undefined,
  catalog: readonly ModelAvailability[]
): string | null => effectiveModelLabel(null, defaultModel, catalog);

/** Favourites after a star click (the prefs patch's value). */
export const toggleFavorite = (
  favorites: readonly string[],
  id: string
): string[] =>
  favorites.includes(id)
    ? favorites.filter((favorite) => favorite !== id)
    : [...favorites, id];

export interface BotModelGroupsInput {
  models: readonly ModelAvailability[];
  /** `prefs.models.favoriteModelIds`. */
  favorites: readonly string[];
  /** `settings.defaultModel`, for App default's sub-label. */
  defaultModel: string | null | undefined;
  /** Free-plan Abacus account: offer the free providers not yet connected. */
  freeTier: boolean;
  labels: BotModelLabels;
  /** Navigate to `/settings/models?provider=<provider>`. */
  onConnect(provider: FreeProvider): void;
  /** Search as typed; empty = no filter. */
  query?: string;
}

export const botModelGroups = (input: BotModelGroupsInput): BotModelGroup[] => {
  const { labels, favorites } = input;
  const query = (input.query ?? "").trim().toLowerCase();
  // Only models that can run now (the old picker's rule).
  const runnable = input.models.filter((model) => model.configured);
  const catalogIndex = new Map(runnable.map((model, i) => [model.id, i]));
  const matches = (model: ModelAvailability): boolean =>
    query === "" ||
    modelSearchText(model, labels.localProvider).includes(query);
  const item = (model: ModelAvailability) => {
    const tier =
      model.tier === "free"
        ? labels.tierFree
        : model.tier === "local"
          ? labels.tierLocal
          : undefined;
    return tier == null
      ? { id: model.id, label: model.label }
      : { id: model.id, label: model.label, description: tier };
  };

  const groups: BotModelGroup[] = [];
  const defaultSub = appDefaultLabel(input.defaultModel, input.models);
  if (query === "" || labels.appDefault.toLowerCase().includes(query))
    groups.push({
      id: "default",
      label: labels.defaultGroup,
      items: [
        defaultSub == null
          ? { id: APP_DEFAULT_ITEM_ID, label: labels.appDefault }
          : {
              id: APP_DEFAULT_ITEM_ID,
              label: labels.appDefault,
              description: defaultSub,
            },
      ],
    });

  const favoriteModels = favorites
    .map((id) => runnable.find((model) => model.id === id))
    .filter(
      (model): model is ModelAvailability => model != null && matches(model)
    );
  if (favoriteModels.length > 0)
    groups.push({
      id: "favorites",
      label: labels.favorites,
      items: favoriteModels.map(item),
    });

  const connected = new Set(runnable.map((model) => model.provider));
  const connectable: FreeProvider[] = input.freeTier
    ? FREE_POOL_PROVIDERS.filter((provider) => !connected.has(provider))
    : [];
  const providerIds = [
    ...new Set([
      ...runnable.map((model) => modelProviderGroup(model.provider)),
      ...(query === "" ? connectable : []),
    ]),
  ].toSorted(byProvider(labels.localProvider));

  for (const provider of providerIds) {
    const members = runnable
      .filter(
        (model) =>
          modelProviderGroup(model.provider) === provider && matches(model)
      )
      .toSorted(
        (left, right) =>
          // OpenLLM leads the Abacus group.
          Number(right.provider === "openllm") -
            Number(left.provider === "openllm") ||
          Number(favorites.includes(right.id)) -
            Number(favorites.includes(left.id)) ||
          // Abacus keeps the catalog's product order; others alphabetical.
          (provider === "abacus"
            ? (catalogIndex.get(left.id) ?? 0) -
              (catalogIndex.get(right.id) ?? 0)
            : 0) ||
          left.label.localeCompare(right.label)
      );
    const connect =
      query === "" && (connectable as string[]).includes(provider)
        ? {
            label:
              provider === "openrouter"
                ? labels.connectOpenRouter
                : provider === "gemini"
                  ? labels.connectGoogleAi
                  : (labels.connectSource?.(provider as FreeProvider) ??
                    modelProviderLabel(provider, labels.localProvider)),
            onSelect: () => input.onConnect(provider as FreeProvider),
          }
        : undefined;
    if (members.length === 0 && connect == null) continue;
    groups.push({
      id: provider,
      label: modelProviderLabel(provider, labels.localProvider),
      items: members.map(item),
      ...(connect != null ? { connect } : {}),
    });
  }
  return groups;
};
