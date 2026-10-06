import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import { BrowserTab } from "#platform/browser-tab";
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
 * URLs the bot's chat or the agent opens land in a browser tab of this
 * bot's panel: one tab per page (a second open of the same page refocuses
 * it), so the agent's pages and the user's sit side by side.
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
    const unsubscribe = registerPreviewConsumer({
      owns: (candidate) => candidate == null || candidate === key,
      open: (event) => {
        if (event.url) open(sessionId, event.url);
      },
    });
    return () => {
      unregister();
      unsubscribe();
    };
  }, [key, sessionId]);
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
      id={tab.id}
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
