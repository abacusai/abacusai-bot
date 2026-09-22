import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState, type JSX } from "react";

import { PROVIDER_KEY_FIELDS } from "#shared/settings";

import { ProviderKeyDialog } from "../components/settings/provider-key-dialog";
import { settingsQueryKeys } from "../lib/settings-query-keys";

/** The free-pool sources a user can add themselves, in the order offered. */
export type FreeSource = "openrouter" | "gemini";
export const FREE_SOURCES: FreeSource[] = ["openrouter", "gemini"];

/** Google's key is pasted by hand; the dialog carries the link to it. */
const GEMINI_FIELD =
  PROVIDER_KEY_FIELDS.find((field) => field.provider === "gemini") ?? null;

/** The free sources the pool could still gain, OpenRouter first. */
export const missingFreeSources = (
  configured: Record<string, boolean> | undefined
): FreeSource[] =>
  FREE_SOURCES.filter((source) => configured?.[source] !== true);

/**
 * One way to connect a free source, shared by the model picker's rows and
 * the out-of-credits cards: the same OAuth hop and the same fallbacks, so
 * the cards cannot drift from the picker. Resolves true only when the source
 * is connected and the catalog re-read; Google's key is pasted into the
 * dialog this returns, which the caller must render, so that path resolves
 * false and the user carries on once the key is in.
 */
export const useConnectFreeProvider = (): {
  connect: (source: FreeSource) => Promise<boolean>;
  connecting: FreeSource | null;
  /** Render this: the key dialog, open only while a paste is being asked for. */
  keyDialog: JSX.Element;
} => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState<FreeSource | null>(null);
  const [askingKey, setAskingKey] = useState(false);

  const connect = useCallback(
    async (source: FreeSource): Promise<boolean> => {
      if (source === "gemini") {
        // The same dialog onboarding and the Models page use, opened here
        // rather than sending the user to Settings; it carries the link.
        setAskingKey(true);
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
      field={GEMINI_FIELD}
      open={askingKey}
      onClose={() => setAskingKey(false)}
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
