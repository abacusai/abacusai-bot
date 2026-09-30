/**
 * Settings, usage, account and model queries arrive with the settings pages
 * (phase 5). The keys the invalidation table names are built here so the
 * table and the pages share one definition.
 */
import type { AppQueryUtils } from "#next/data/transport";

export const settingsKeys = (orpc: AppQueryUtils) => ({
  providers: orpc.settings.keys.listProviders.key(),
  account: orpc.account.key(),
  models: orpc.models.list.key(),
});
