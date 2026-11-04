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
import {
  FREE_POOL_PROVIDERS,
  type FreePoolProvider,
} from "@abacus-ai/contract/free-pool";
import {
  modelAccess,
  OPENLLM_ID,
  resolveConfiguredModel,
  type ModelAvailability,
} from "@abacus-ai/contract/models";
import { PROVIDER_KEY_FIELDS } from "@abacus-ai/contract/settings";

/** Structurally the chat kit's `ModelGroup` (features/chat/kit/context.tsx). */
export interface BotModelGroup {
  id: string;
  label: string;
  items: Array<{
    id: string;
    label: string;
    description?: string;
    /** App default's row: the model it resolves to, by id. */
    resolves?: string;
    /** Not in the account's plan: shown greyed, and choosing it upgrades. */
    locked?: { label: string; onSelect(): void };
  }>;
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
  connectOpenRouter: string;
  connectGoogleAi: string;
  connectSource?: (provider: FreeProvider) => string;
  /** Tier badges shown as the item's description ("Free", "Local"). */
  tierFree: string;
  tierLocal: string;
  /** A locked model's note: "Included in Basic", or the plan-less wording for null. */
  includedIn?: (plan: string | null) => string;
}

const PROVIDER_LABELS = new Map(
  PROVIDER_KEY_FIELDS.map((field) => [field.provider, field.label])
);

/** abacus and openllm share one group, as in the old picker. */
const modelProviderGroup = (provider: string): string =>
  provider === "openllm" || provider === "abacus" ? "abacus" : provider;

const modelProviderLabel = (provider: string): string => {
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

const byProvider = (left: string, right: string): number =>
  (PINNED_PROVIDERS[left] ?? 9) - (PINNED_PROVIDERS[right] ?? 9) ||
  modelProviderLabel(left).localeCompare(modelProviderLabel(right));

/** What the old picker's search matched: label, id, provider name, note. */
export const modelSearchText = (model: ModelAvailability): string =>
  `${model.label} ${model.id} ${modelProviderLabel(
    modelProviderGroup(model.provider)
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

/**
 * What a chat's model chip names. A pinned chat runs its pin as is (main's
 * startAgentSession), so the chip names the pin, unavailable when no
 * connected provider lists it now; an unpinned one, what the resolver picks.
 */
export const chatModelChip = (
  pin: string | null | undefined,
  requested: string | null,
  defaultModel: string | null | undefined,
  catalog: readonly ModelAvailability[]
): { label: string; unavailable: boolean } | null => {
  if (pin == null || pin === "") {
    const label = effectiveModelLabel(requested, defaultModel, catalog);
    return label == null ? null : { label, unavailable: false };
  }
  // An empty catalog (still loading, unreadable) cannot judge the pin.
  const row = catalog.find((model) => model.id === pin);
  // A paid plan's catalog drops the free pool: the plan's router serves it.
  const router = catalog.find((model) => model.recommended === true);
  if (pin === OPENLLM_ID && row == null && router != null)
    return { label: router.label, unavailable: false };
  return {
    label: row?.label ?? pin,
    unavailable: catalog.length > 0 && row?.configured !== true,
  };
};

/**
 * The model a chat will run when it comes from another provider (not Abacus,
 * not RouteLLM): its label, its provider's name
 * and whether it is free. Null otherwise.
 */
export const otherProviderModel = (
  botModel: string | null,
  defaultModel: string | null | undefined,
  catalog: readonly ModelAvailability[]
): { label: string; provider: string; free: boolean } | null => {
  const id = resolveConfiguredModel({
    requested: botModel,
    defaultModel,
    catalog,
  });
  const model = catalog.find((item) => item.id === id);
  if (model == null || modelProviderGroup(model.provider) === "abacus")
    return null;
  return {
    label: model.label,
    provider: modelProviderLabel(model.provider),
    free: model.tier === "free",
  };
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
  /**
   * The upgrade flow, for a model the plan does not include. Without it
   * locked models are left out, since nothing could be done with them.
   */
  onUpgrade?(): void;
}

export const botModelGroups = (input: BotModelGroupsInput): BotModelGroup[] => {
  const { labels, favorites } = input;
  const query = (input.query ?? "").trim().toLowerCase();
  // Only models that can run now (the old picker's rule), plus the models
  // the plan does not include, greyed behind the upgrade.
  const runnable = input.models.filter((model) => model.configured);
  const onUpgrade = input.onUpgrade;
  const includedIn = labels.includedIn;
  const locked =
    onUpgrade == null || includedIn == null
      ? []
      : input.models.filter((model) => modelAccess(model) === "locked");
  const lockedItem = (model: ModelAvailability) => ({
    id: model.id,
    label: model.label,
    locked: {
      label: includedIn?.(model.unlockPlan ?? null) ?? "",
      onSelect: () => onUpgrade?.(),
    },
  });
  const catalogIndex = new Map(runnable.map((model, i) => [model.id, i]));
  const matches = (model: ModelAvailability): boolean =>
    query === "" || modelSearchText(model).includes(query);
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
  const defaultId = resolveConfiguredModel({
    requested: null,
    defaultModel: input.defaultModel,
    catalog: input.models,
  });
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
              ...(defaultId == null ? {} : { resolves: defaultId }),
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
      ...locked.map((model) => modelProviderGroup(model.provider)),
      ...(query === "" ? connectable : []),
    ]),
  ].toSorted(byProvider);

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
                    modelProviderLabel(provider)),
            onSelect: () => input.onConnect(provider as FreeProvider),
          }
        : undefined;
    // After the runnable ones, in catalog order.
    const lockedMembers = locked.filter(
      (model) =>
        modelProviderGroup(model.provider) === provider && matches(model)
    );
    if (members.length === 0 && lockedMembers.length === 0 && connect == null)
      continue;
    groups.push({
      id: provider,
      label: modelProviderLabel(provider),
      items: [...members.map(item), ...lockedMembers.map(lockedItem)],
      ...(connect != null ? { connect } : {}),
    });
  }
  return groups;
};
