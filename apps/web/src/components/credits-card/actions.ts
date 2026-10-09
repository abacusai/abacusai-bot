import { isFreePoolProvider } from "@abacus-ai/contract/free-pool";

import type { Transport } from "#renderer/data/transport";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
import { sidebarAccount } from "#renderer/lib/sidebar-account";
import { openUpgrade } from "#renderer/lib/upgrade";

import type { CreditActions } from "./index";
/** `connected`: what the document re-reads once a source connects. */
export const creditActionsFor = (
  transport: Transport,
  connected?: () => Promise<unknown>
): CreditActions => {
  const client = transport.client;
  return {
    openExternal: (url) => platformSystem(client).openExternal({ url }),
    openUpgrade: () => openUpgrade(client),
    canTopUpCredits: async () =>
      sidebarAccount(await client.account.abacus()).billing === "manage",
    configuredFreeSources: async () => {
      const [models, keys] = await Promise.all([
        client.models.list({}),
        client.settings.keys.listProviders({}),
      ]);
      return Object.fromEntries(
        [
          ...keys,
          ...models
            .filter((model) => model.configured)
            .map((model) => model.provider),
        ]
          .filter(isFreePoolProvider)
          .map((provider) => [provider, true])
      );
    },
    connectFreeSource: async (source, key) => {
      if (IS_ELECTRON && source === "openrouter" && key == null) {
        const result = await client.auth.openRouter.start({});
        if (!result.ok) return false;
      } else {
        if (key == null) return false;
        await client.settings.keys.save({ provider: source, key });
      }
      await client.models.list({ refresh: true });
      await connected?.();
      return true;
    },
    markCreditsExhausted: async () => {
      await client.db.prefs.update({
        patch: { creditsExhaustedAt: Date.now() },
      });
    },
  };
};

/** A command acknowledgement means written to stdin; wait for the live model. */
export const confirmFreePoolModel = async (
  transport: Pick<Transport, "client">,
  scope: { workspaceId: string; sessionId: string }
): Promise<void> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const state = await transport.client.agent.state(scope);
    if (
      state == null ||
      state.model === "abacus/openllm" ||
      state?.status === "stopped" ||
      state?.status === "error"
    )
      return;
    if (Date.now() >= deadline)
      throw new Error("The agent did not confirm the free-pool model");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
