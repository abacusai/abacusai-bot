import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { AgentKeyConnector } from "../../connectors";
import { settingsQueryKeys } from "../../lib/settings-query-keys";

/**
 * Store an agent-key connector's credential, from the Connectors page or the
 * chat's Connect card alike. Main puts it in every running agent's
 * environment and the next ones spawn with it; nothing is installed.
 */
export const useAgentKeySaver = (): ((
  connector: AgentKeyConnector,
  value: string
) => Promise<void>) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useCallback(
    async (connector, value) => {
      try {
        await window.api.agent.saveApiKey(connector.credentialProvider, value);
        toast.success(
          t(
            value.trim().length > 0 ? "connectors.added" : "connectors.removed",
            {
              name: connector.name,
            }
          )
        );
        await queryClient.invalidateQueries({
          queryKey: settingsQueryKeys.connectors.storedKeys,
        });
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t("connectors.addFailed", { name: connector.name })
        );
        throw error;
      }
    },
    [queryClient, t]
  );
};
