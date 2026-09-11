import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { useAccountStore } from "../stores/account-store";
import { workspaceQueryKeys } from "./query-keys";
import { settingsQueryKeys } from "./settings-query-keys";

/**
 * Every cache that is a function of which keys the app holds, in one place.
 * Each is read by a long-lived component caching for a minute, so a credential
 * arriving by any route (browser hop, pasted key, sign-out) must invalidate
 * all of them together; invalidating them one consumer at a time leaves the
 * others showing a stale answer.
 */
const CREDENTIAL_QUERIES: {
  key: readonly unknown[];
  /** Only Abacus credentials change this one. */
  abacusOnly?: boolean;
}[] = [
  { key: workspaceQueryKeys.modelBots },
  { key: workspaceQueryKeys.appSettings },
  { key: settingsQueryKeys.models.all },
  { key: workspaceQueryKeys.abacusAccount, abacusOnly: true },
  { key: settingsQueryKeys.models.abacusCredential, abacusOnly: true },
  // The connector gateway arrives and leaves with the Abacus key.
  { key: settingsQueryKeys.connectors.all, abacusOnly: true },
];

/** The keys a change from `provider` invalidates. Exported for its test. */
export const credentialQueryKeys = (
  provider: string | undefined
): readonly unknown[][] =>
  CREDENTIAL_QUERIES.filter(
    (entry) => entry.abacusOnly !== true || provider === "abacus"
  ).map((entry) => [...entry.key]);

// Subscribed once at the app root; components must not add their own listener.
export const useCredentialRefresh = (): void => {
  const queryClient = useQueryClient();

  useEffect(
    () =>
      window.api.agent.onEvent((event) => {
        if (event.type !== "credentials-changed") return;
        if (event.provider === "abacus") {
          if (event.configured != null) {
            queryClient.setQueryData(
              settingsQueryKeys.models.abacusCredential,
              event.configured
            );
            if (!event.configured) {
              queryClient.setQueryData(workspaceQueryKeys.abacusAccount, null);
            }
          }
          void useAccountStore.getState().load();
        }
        for (const queryKey of credentialQueryKeys(event.provider)) {
          void queryClient.invalidateQueries({ queryKey });
        }
      }),
    [queryClient]
  );
};
