import { Bot, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ABACUS_AGENT_URL } from "#renderer/lib/abacus-links";
import { cn } from "#renderer/lib/cn";
import { platformSystem } from "#renderer/lib/platform-system";
import { sidebarAccount } from "#renderer/lib/sidebar-account";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Tooltip, TooltipContent, TooltipTrigger } from "#renderer/ui/tooltip";

import { useFloatingIntent } from "./floating-intent";

export const AgentLink = ({ compact = false }: { compact?: boolean }) => {
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
      onPointerEnter={compact ? intent.cancel : undefined}
      onClick={(event) => {
        event.preventDefault();
        void platformSystem(transport.client).openExternal({
          url: ABACUS_AGENT_URL,
        });
      }}
      className={cn(
        "titlebar-nodrag text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground focus-visible:ring-ring flex h-8 shrink-0 items-center gap-2 rounded-(--pane-radius) px-2 text-xs outline-none focus-visible:ring-2",
        compact && "size-8 justify-center px-0"
      )}
    >
      <Bot className="size-4 shrink-0" aria-hidden />
      {!compact && (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <ExternalLink className="size-3 shrink-0" aria-hidden />
        </>
      )}
    </a>
  );
  return compact ? (
    <Tooltip>
      <TooltipTrigger render={link} />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  ) : (
    link
  );
};
