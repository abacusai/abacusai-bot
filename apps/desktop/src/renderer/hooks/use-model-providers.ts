import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { PROVIDER_KEY_FIELDS } from "#shared/settings";

import { settingsQueryKeys } from "../lib/settings-query-keys";

export type ModelProviderState = {
  /** Provider id -> can it run right now (a key on disk, or one in the shell). */
  configured: Record<string, boolean>;
  /** Providers whose key this app stored, so Remove has something to remove. */
  stored: Set<string>;
};

/**
 * Which providers the app can run, shared by the settings panel and the
 * out-of-credits card: both answer "what else could this user use", and two
 * copies of the question drift. Keyed under `settings.models`, which the
 * credential refresh invalidates, so a key added anywhere lands here.
 */
export const useModelProvidersQuery = (): UseQueryResult<ModelProviderState> =>
  useQuery<ModelProviderState>({
    queryKey: settingsQueryKeys.models.providers,
    staleTime: 60_000,
    queryFn: async () => {
      const [models, storedProviders] = await Promise.all([
        window.api.agent.listModels(),
        window.api.agent.listStoredKeyProviders(),
      ]);
      const stored = new Set(storedProviders);
      const configured: Record<string, boolean> = {};
      for (const field of PROVIDER_KEY_FIELDS) {
        configured[field.provider] =
          models.some(
            (model) => model.provider === field.provider && model.configured
          ) || stored.has(field.provider);
      }
      return { configured, stored };
    },
  });
