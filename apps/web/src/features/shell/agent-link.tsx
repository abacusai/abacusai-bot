import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AppBrandMark } from "#renderer/components/app-icon";
import { ABACUS_AGENT_URL } from "#renderer/lib/abacus-links";
import { platformSystem } from "#renderer/lib/platform-system";
import { sidebarAccount } from "#renderer/lib/sidebar-account";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Tooltip, TooltipContent, TooltipTrigger } from "#renderer/ui/tooltip";

import { useFloatingIntent } from "./floating-intent";

export const AgentLink = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const account = useAccount();
  const intent = useFloatingIntent();
  if (!sidebarAccount(account.data).paid) return null;
  const label = t("profile.agent");
  const link = (
    <a
      href={ABACUS_AGENT_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      data-slot="agent-link"
      onPointerEnter={intent.cancel}
      onClick={(event) => {
        event.preventDefault();
        void platformSystem(transport.client).openExternal({
          url: ABACUS_AGENT_URL,
        });
      }}
      className="titlebar-nodrag text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground focus-visible:ring-ring/50 flex size-9 shrink-0 items-center justify-center rounded-[10px] outline-none focus-visible:ring-2"
    >
      <AppBrandMark size={18} />
    </a>
  );
  return (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipContent side="right">
        {label}
        <ExternalLink className="size-3" aria-hidden />
      </TooltipContent>
    </Tooltip>
  );
};
