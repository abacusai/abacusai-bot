/**
 * Main's side of the one model resolver (spec 03 §13.2, §24.10 a): the model
 * a session runs on, whether a chat, a bot's chat or a routine's run, from
 * the live catalog and the stored app default, with the same
 * `resolveConfiguredModel` the renderer displays with. An unconfigured
 * stored default or bot model (a removed credential) is never started.
 *
 * Only an authoritative answer moves a session off its stored pin: a catalog
 * row for the wanted model that says its credential is gone, or that the
 * account's plan does not include it (locked). A catalog that
 * cannot be read or comes back empty, or one that simply lacks the wanted
 * id (offline, the plan tier unknown, a live list that did not answer),
 * keeps the stored pin; a brand-new session (no pin yet) then takes the
 * synchronous default it always had: the wanted model, else the tier's
 * cached recommendation.
 *
 * The plan is authoritative too: on a paying tier a pin or default to an
 * OpenLLM model (the free plan's) is read as the tier's router
 * (`modelForTier`), whether or not the catalog could be read.
 */
import {
  modelAccess,
  resolveConfiguredModel,
  type ModelAvailability,
} from "@abacus-ai/contract/models";
import { abacusAccountTier } from "@abacus-ai/contract/models";

import { readSettings } from "../config/settings";
import { cachedAbacusAccount } from "./abacus";
import {
  cachedRecommendedModelId,
  listAvailableModels,
  modelForTier,
} from "./models";

export interface SessionModelSources {
  /** `config.json`'s `defaultModel` (set in Settings > Models), if any. */
  readDefault(): string | null | undefined;
  /** The catalog with `configured` and `recommended` (`listAvailableModels`). */
  listCatalog(): Promise<readonly ModelAvailability[]>;
  /** The tier's recommendation as of the last catalog read, if any. */
  cachedRecommended?(): string | null;
  /** The account's plan tier as last read (`subscription_tier`), if known. */
  tier?(): string | null | undefined;
}

/** The app's own sources: the stored default and the live catalog. */
const appModelSources: SessionModelSources = {
  readDefault: () => readSettings().defaultModel,
  listCatalog: () => listAvailableModels(),
  cachedRecommended: () => cachedRecommendedModelId(),
  tier: () => currentTier(),
};

/** The plan tier as of the last account read: what `modelForTier` judges by. */
export const currentTier = (): string | undefined =>
  abacusAccountTier(cachedAbacusAccount());

const present = (id: string | null | undefined): string | null =>
  id == null || id.length === 0 ? null : id;

/**
 * `requested` is the session's own ask: a bot's model, a routine's own, or
 * null for the app default. `pin` is the session's stored model (null for a
 * session not yet pinned).
 */
export const resolveSessionModel = async (
  requested: string | null,
  sources: SessionModelSources = appModelSources,
  pin: string | null = null
): Promise<string | null> => {
  const tier = sources.tier?.();
  const onTier = (id: string | null): string | null =>
    id == null ? null : modelForTier(tier, id);
  const defaultModel = present(sources.readDefault());
  const wanted = onTier(present(requested) ?? defaultModel);
  const pinned = onTier(present(pin));
  const syncDefault = (): string | null =>
    wanted ?? present(sources.cachedRecommended?.());

  let catalog: readonly ModelAvailability[];
  try {
    catalog = await sources.listCatalog();
  } catch {
    catalog = [];
  }
  // No catalog to judge by: nothing authoritative, the pin stands.
  if (catalog.length === 0) return pinned ?? syncDefault();

  const row =
    wanted == null ? undefined : catalog.find((entry) => entry.id === wanted);
  if (row?.configured === true) return wanted;
  // The catalog does not list it at all: degraded, not "credential gone".
  if (wanted != null && row == null && pinned != null) return pinned;

  const resolved = resolveConfiguredModel({
    requested,
    defaultModel,
    catalog,
  });
  if (resolved != null) return resolved;
  // Nothing runnable: a pinned session keeps its pin (null: no write); a new
  // one is still pinned, so it does not start on the CLI's own fallback, but
  // never on a model its plan does not include.
  if (pinned != null) return null;
  return row != null && modelAccess(row) === "locked"
    ? present(sources.cachedRecommended?.())
    : syncDefault();
};

/**
 * The model a new routine keeps as its own: its bot's, else the one the chat
 * that made it is on, else the app default (the plan's model when none is set).
 */
export const newRoutineModel = (
  botModel: string | null | undefined,
  chatModel: string | null | undefined,
  sources: SessionModelSources = appModelSources
): Promise<string | null> =>
  resolveSessionModel(present(botModel) ?? present(chatModel), sources);
