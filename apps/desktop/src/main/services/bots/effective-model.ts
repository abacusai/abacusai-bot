/**
 * Main's side of the one model resolver (spec 03 §13.2, §24.10 a): the model
 * a bot session runs on, from the live catalog and the stored app default,
 * with the same `resolveConfiguredModel` the renderer displays with. An
 * unconfigured stored default or bot model (a removed credential, an id the
 * catalog no longer offers) is never started.
 */
import { resolveConfiguredModel, type ModelAvailability } from "#shared/models";

export interface EffectiveModelSources {
  /** `config.json`'s `defaultModel` (the user's last pick), if any. */
  readDefault(): string | null | undefined;
  /** The catalog with `configured` and `recommended` (`listAvailableModels`). */
  listCatalog(): Promise<readonly ModelAvailability[]>;
}

export const effectiveBotModel = async (
  requested: string | null,
  sources: EffectiveModelSources
): Promise<string | null> =>
  resolveConfiguredModel({
    requested,
    defaultModel: sources.readDefault() ?? null,
    catalog: await sources.listCatalog(),
  });
