/**
 * The keys `settings.events` invalidates, built here so the notice follower
 * and the pages share one definition (spec 01 §8.4; spec 00 A-T11).
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { AppQueryUtils, Transport } from "#renderer/data/transport";

import { followNotice } from "./notices";

export const settingsKeys = (orpc: AppQueryUtils) => ({
  providers: orpc.settings.keys.listProviders.key(),
  account: orpc.account.key(),
  models: orpc.models.list.key(),
  settings: orpc.settings.get.key(),
});

/** What the context tray and the picker read about the backend. */
const execBackendKeys = (orpc: AppQueryUtils): QueryKey[] => [
  orpc.settings.execBackend.get.key(),
  orpc.settings.sandboxSupport.key(),
];

const credentialKeys = (orpc: AppQueryUtils): QueryKey[] => [
  ...Object.values(settingsKeys(orpc)),
  orpc.connectors.statuses.key(),
];

/**
 * Until `signal` aborts: what `settings.events` makes stale. The stream has
 * no snapshot, so a notice sent while it was down is lost: every reopen
 * invalidates what a notice could have.
 */
export const followSettingsNotices = (
  transport: Transport,
  queryClient: Pick<QueryClient, "invalidateQueries">,
  signal: AbortSignal
): void => {
  const { orpc } = transport;
  const invalidate = (keys: QueryKey[]): void => {
    for (const queryKey of keys)
      void queryClient.invalidateQueries({ queryKey });
  };
  followNotice(
    "settings",
    transport,
    (event) => {
      if (event.type === "exec-backend") invalidate(execBackendKeys(orpc));
      if (event.type === "credentials-changed")
        invalidate(credentialKeys(orpc));
    },
    signal,
    {
      reopened: () =>
        invalidate([...credentialKeys(orpc), ...execBackendKeys(orpc)]),
    }
  );
};

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
