import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";

import { settingsQueryKeys } from "../lib/settings-query-keys";

/** The free-pool sources a user can add themselves, in the order offered. */
export type FreeSource = "openrouter" | "gemini";
export const FREE_SOURCES: FreeSource[] = ["openrouter", "gemini"];

export const GOOGLE_AI_STUDIO_KEY_URL = "https://aistudio.google.com/apikey";

/** The free sources the pool could still gain, OpenRouter first. */
export const missingFreeSources = (
  configured: Record<string, boolean> | undefined
): FreeSource[] =>
  FREE_SOURCES.filter((source) => configured?.[source] !== true);

/**
 * One way to connect a free source, shared by the model picker's rows and
 * the out-of-credits cards: the same OAuth hop and the same fallbacks, so
 * the cards cannot drift from the picker. Resolves true only when the
 * source is connected and the catalog re-read; Google's key is pasted by
 * hand in the keys panel, so that path resolves false and the user comes back.
 */
export const useConnectFreeProvider = (): {
  connect: (source: FreeSource) => Promise<boolean>;
  connecting: FreeSource | null;
} => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [connecting, setConnecting] = useState<FreeSource | null>(null);

  const connect = useCallback(
    async (source: FreeSource): Promise<boolean> => {
      if (source === "gemini") {
        // Fetch the key in the browser, paste it in the keys panel — both
        // opened together so the two halves of the errand meet.
        void window.api.openExternal(GOOGLE_AI_STUDIO_KEY_URL);
        void navigate({
          to: "/settings/models",
          search: { provider: "gemini" },
        });
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

  return { connect, connecting };
};
