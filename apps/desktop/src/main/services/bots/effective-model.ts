/**
 * Main's side of the one model resolver (spec 03 §13.2, §24.10 a): the model
 * a bot session runs on, from the live catalog and the stored app default,
 * with the same `resolveConfiguredModel` the renderer displays with. An
 * unconfigured stored default or bot model (a removed credential) is never
 * started.
 *
 * Only an authoritative answer moves a session off its stored pin: a catalog
 * row for the wanted model that says its credential is gone. A catalog that
 * cannot be read or comes back empty, or one that simply lacks the wanted
 * id (offline, the plan tier unknown, a live list that did not answer),
 * keeps the stored pin; a brand-new session (no pin yet) then takes the
 * synchronous default it always had: the wanted model, else the tier's
 * cached recommendation.
 */
import { resolveConfiguredModel, type ModelAvailability } from "#shared/models";

export interface EffectiveModelSources {
  /** `config.json`'s `defaultModel` (the user's last pick), if any. */
  readDefault(): string | null | undefined;
  /** The catalog with `configured` and `recommended` (`listAvailableModels`). */
  listCatalog(): Promise<readonly ModelAvailability[]>;
  /** The tier's recommendation as of the last catalog read, if any. */
  cachedRecommended?(): string | null;
}

const present = (id: string | null | undefined): string | null =>
  id == null || id.length === 0 ? null : id;

/**
 * `requested` is the bot's own model (null: the app default); `pin` is the
 * session's stored model (null for a session not yet pinned).
 */
export const effectiveBotModel = async (
  requested: string | null,
  sources: EffectiveModelSources,
  pin: string | null = null
): Promise<string | null> => {
  const defaultModel = present(sources.readDefault());
  const wanted = present(requested) ?? defaultModel;
  const pinned = present(pin);
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
  // one is still pinned, so it does not start on the CLI's own fallback.
  return pinned != null ? null : syncDefault();
};
