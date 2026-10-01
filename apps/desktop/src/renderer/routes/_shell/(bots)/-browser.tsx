import { useSearch, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import {
  BrowserTab,
  useSession,
  useWorkspace,
} from "#renderer/features/sessions";
import {
  nativePresenterFor,
  registerBrowserOpen,
  useBrowserOpenUrl,
  shellStore,
  registerPreviewConsumer,
  requestBrowserOpen,
} from "#renderer/features/shell";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";

export const BotBrowserRegistration = ({
  sessionId,
}: {
  sessionId: string;
}) => {
  const row = useSession(sessionId);
  const navigate = useAppNavigate();
  const key = row
    ? JSON.stringify(["conversation", 1, row.workspaceId, "session", row.id])
    : undefined;
  const open = useEffectEvent((id: string, url?: string) => {
    if (id !== sessionId) return;
    if (url) requestBrowserOpen({ sessionId, url });
    void navigate({
      search: (p: Record<string, unknown>) => ({ ...p, tab: "browser" }),
      transition: "none",
    } as never);
  });
  useEffect(() => {
    const unregister = registerBrowserOpen(({ sessionId }) => open(sessionId));
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

export const BotBrowser = ({ sessionId }: { sessionId: string }) => {
  const { transport } = useRouter().options.context;
  const row = useSession(sessionId);
  const workspace = useWorkspace(row?.workspaceId ?? "");
  const url = useBrowserOpenUrl(sessionId);
  const tab = (useSearch({ strict: false }) as { tab?: string }).tab;
  if (!row) return null;
  return (
    <BrowserTab
      row={row}
      id="bot-browser"
      url={url}
      root={row.worktreePath ?? workspace?.path ?? ""}
      visible={tab === "browser"}
      presenter={nativePresenterFor(transport.client)}
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
