import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState, type JSX } from "react";

import { FREE_POOL_PROVIDERS, type FreePoolProvider } from "#shared/free-pool";
import { PROVIDER_KEY_FIELDS, type ProviderKeyField } from "#shared/settings";

import { ProviderKeyDialog } from "../components/settings/provider-key-dialog";
import { settingsQueryKeys } from "../lib/settings-query-keys";

/** A source the pool can gain: what the cards and the picker offer. */
export type FreeSource = FreePoolProvider;

/** The out-of-credits cards offer the next two, never a wall of rows. */
const CARD_SOURCES = 2;

const keyField = (source: FreePoolProvider): ProviderKeyField | null =>
  PROVIDER_KEY_FIELDS.find((field) => field.provider === source) ?? null;

/**
 * The next sources the pool could gain, in the order it spends them: Gemini
 * and OpenRouter first, then the rest two at a time as those are connected.
 */
export const missingFreeSources = (
  configured: Record<string, boolean> | undefined
): FreeSource[] =>
  FREE_POOL_PROVIDERS.filter((source) => configured?.[source] !== true).slice(
    0,
    CARD_SOURCES
  );

/**
 * One way to connect a free source, shared by the model picker's rows and
 * the out-of-credits cards: the same OAuth hop and the same fallbacks, so
 * the cards cannot drift from the picker. Resolves true only when the source
 * is connected and the catalog re-read. OpenRouter signs in through the
 * browser; every other source's key is pasted into the dialog this returns,
 * which the caller must render, so that path resolves false and the user
 * carries on once the key is in.
 */
export const useConnectFreeProvider = (): {
  connect: (source: FreePoolProvider) => Promise<boolean>;
  connecting: FreePoolProvider | null;
  /** Render this: the key dialog, open only while a paste is being asked for. */
  keyDialog: JSX.Element;
} => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState<FreePoolProvider | null>(null);
  const [askingKey, setAskingKey] = useState<ProviderKeyField | null>(null);

  const connect = useCallback(
    async (source: FreePoolProvider): Promise<boolean> => {
      if (source !== "openrouter") {
        // The same dialog onboarding and the Models page use, opened here
        // rather than sending the user to Settings; it carries the link.
        setAskingKey(keyField(source));
        return false;
      }
      setConnecting(source);
      try {
        const result = await window.api.agent.startOpenRouterAuth();
        if (result.ok === true) {
          // The credentials-changed event invalidates the caches; the forced
          // catalog read is what puts the new models in them.
          await window.api.agent.listModels(true);
          await queryClient.invalidateQueries({
            queryKey: settingsQueryKeys.models.all,
          });
          return true;
        }
        // A cancelled sign-in is a decision, not a failure.
        if (result.cancelled !== true) {
          void navigate({
            to: "/settings/models",
            search: { provider: "openrouter" },
          });
        }
        return false;
      } finally {
        setConnecting(null);
      }
    },
    [navigate, queryClient]
  );

  const keyDialog = (
    <ProviderKeyDialog
      field={askingKey}
      open={askingKey != null}
      onClose={() => setAskingKey(null)}
      onSaved={async () => {
        await window.api.agent.listModels(true);
        await queryClient.invalidateQueries({
          queryKey: settingsQueryKeys.models.all,
        });
      }}
    />
  );

  return { connect, connecting, keyDialog };
};
