/**
 * Settings, usage, account and model queries arrive with the settings pages
 * (phase 5). The keys the invalidation table names are built here so the
 * table and the pages share one definition.
 */
import type { QueryClient } from "@tanstack/react-query";

import type { AppQueryUtils } from "#renderer/data/transport";

export const settingsKeys = (orpc: AppQueryUtils) => ({
  providers: orpc.settings.keys.listProviders.key(),
  account: orpc.account.key(),
  models: orpc.models.list.key(),
  settings: orpc.settings.get.key(),
});

/**
 * After this window changed a credential: what `credentials-changed`
 * invalidates, at once. The route gates cache "signed in" until it is
 * invalidated, so the next navigation must not race (or lose) the notice.
 */
export const invalidateCredentials = async (
  queryClient: QueryClient,
  orpc: AppQueryUtils
): Promise<void> => {
  await Promise.all(
    Object.values(settingsKeys(orpc)).map((queryKey) =>
      queryClient.invalidateQueries({ queryKey })
    )
  );
};
