import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import { BrowserTab } from "#platform/browser-tab";
import {
  panelTabResource,
  showAgentBrowser,
} from "#renderer/features/bots/browser/agent-tab";
import {
  useSession,
  useWorkspace,
} from "#renderer/features/sessions/data/queries";
import { registerBrowserOpen } from "#renderer/features/shell/browser-open";
import {
  openPanelTab,
  panelScopeKey,
  updatePanelTab,
  type PanelTab,
} from "#renderer/features/shell/panel-store";
import { nativePresenterFor } from "#renderer/features/shell/platform-presenter";
import { registerPreviewConsumer } from "#renderer/features/shell/preview-consumers";
import { shellStore } from "#renderer/features/shell/shell-store";
import { IS_ELECTRON } from "#renderer/lib/platform";

/**
 * Pages the user opens from the bot's chat land in browser tabs of this
 * bot's panel, one per page (a second open of the same page refocuses it).
 * The agent's navigations show the one page it drives (`showAgentBrowser`),
 * so what the user watches, and signs in on, is the agent's own page.
 */
export const BotBrowserRegistration = ({
  botId,
  sessionId,
}: {
  botId: string;
  sessionId: string;
}) => {
  const row = useSession(sessionId);
  const key = row
    ? JSON.stringify(["conversation", 1, row.workspaceId, "session", row.id])
    : undefined;
  const open = useEffectEvent((id: string, url?: string) => {
    if (id !== sessionId) return;
    openPanelTab(panelScopeKey("bots", botId)!, {
      kind: "browser",
      ...(url ? { url } : {}),
    });
  });
  useEffect(() => {
    if (!IS_ELECTRON) return;
    const unregister = registerBrowserOpen(({ sessionId, url }) =>
      open(sessionId, url)
    );
    // The agent's navigations show its own page, never a copy in a new tab.
    const unsubscribe = registerPreviewConsumer({
      owns: (candidate) => candidate == null || candidate === key,
      open: (event) => {
        if (!event.url) return false;
        showAgentBrowser(panelScopeKey("bots", botId)!, event.url);
        return true;
      },
    });
    return () => {
      unregister();
      unsubscribe();
    };
  }, [key, sessionId, botId]);
  return null;
};

/** One of the bot panel's browser tabs: its own runtime and history. */
export const BotBrowser = ({
  botId,
  sessionId,
  tab,
  active,
}: {
  botId: string;
  sessionId: string;
  tab: PanelTab;
  active: boolean;
}) => {
  const { transport } = useRouter().options.context;
  const row = useSession(sessionId);
  const workspace = useWorkspace(row?.workspaceId ?? "");
  if (!row) return null;
  const scope = panelScopeKey("bots", botId)!;
  return (
    <BrowserTab
      row={row}
      id={panelTabResource(tab)}
      url={tab.url}
      root={row.worktreePath ?? workspace?.path ?? ""}
      visible={active}
      presenter={nativePresenterFor(transport.client)}
      onState={({ url, title }) =>
        updatePanelTab(scope, tab.id, { url, title: title || url })
      }
      blocked={(rect) =>
        document.querySelector(
          '[role="dialog"], [data-slot="popover-content"], [data-slot="dropdown-menu-content"]'
        ) !== null ||
        shellStore.state.occlusion.rects.some(
          (r) =>
            r.x < rect.right &&
            r.x + r.width > rect.left &&
            r.y < rect.bottom &&
            r.y + r.height > rect.top
        )
      }
    />
  );
};
