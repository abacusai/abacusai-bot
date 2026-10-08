import type { ModelAvailability } from "@abacus-ai/contract/models";
import { PROVIDER_KEY_FIELDS } from "@abacus-ai/contract/settings";
import { useQuery } from "@tanstack/react-query";

import { signInAbacus } from "#platform/sign-in";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { useAppContext } from "#renderer/lib/use-app-context";

import type { ModelSetupBinding } from "./types";

const PROVIDERS = ["abacus", "openrouter", "openai", "anthropic", "gemini"];

export const useModelSetup = ({
  models,
  loading,
  failed,
  select,
}: {
  models: readonly ModelAvailability[];
  loading: boolean;
  failed: boolean;
  select(id: string): void;
}): ModelSetupBinding => {
  const { transport, credentialsChanged } = useAppContext();
  const navigate = useAppNavigate();
  const keys = useQuery(
    transport.orpc.settings.keys.listProviders.queryOptions({ input: {} })
  );
  const local = useQuery(
    transport.orpc.localModels.state.queryOptions({
      input: {},
      enabled: IS_ELECTRON,
    })
  );
  const refresh = async (choose = false) => {
    const catalog = await transport.client.models.list({ refresh: true });
    await credentialsChanged();
    if (choose) {
      const first = catalog.find((model) => model.configured);
      if (first) select(first.id);
    }
  };
  return {
    status: failed
      ? "error"
      : loading
        ? "loading"
        : models.some((model) => model.configured)
          ? "ready"
          : "empty",
    providers: PROVIDERS.flatMap((id) => {
      const field = PROVIDER_KEY_FIELDS.find((field) => field.provider === id);
      return field
        ? [
            {
              id,
              label: field.label,
              connected:
                keys.data?.includes(id) === true ||
                models.some(
                  (model) => model.configured && model.provider === id
                ),
              connect:
                field.connect === "abacus" ||
                (IS_ELECTRON && field.connect === "openrouter"),
            },
          ]
        : [];
    }),
    localAvailable: IS_ELECTRON && local.data?.runtimeAvailable === true,
    connect: async (provider) => {
      const result =
        provider === "abacus"
          ? await signInAbacus(transport, {})
          : await transport.client.auth.openRouter.start({});
      if (!result.ok) {
        if (!result.cancelled) throw new Error(result.error);
        return false;
      }
      await refresh(true);
      return true;
    },
    save: async (provider, key) => {
      await transport.client.settings.keys.save({ provider, key });
      await refresh(true);
    },
    retry: () => refresh(),
    settings: (provider) =>
      void navigate({
        to: "/settings/models",
        search: (previous) => ({ ...previous, provider }),
        transition: "settings-in",
      }),
  };
};
