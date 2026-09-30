import { useSearch, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import { BrowserTab, useSession, useWorkspace } from "#next/features/sessions";
import {
  nativePresenterFor,
  registerBrowserOpen,
  useBrowserOpenUrl,
  shellStore,
} from "#next/features/shell";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";

export const BotBrowser = ({ sessionId }: { sessionId: string }) => {
  const { transport } = useRouter().options.context;
  const navigate = useAppNavigate();
  const row = useSession(sessionId);
  const workspace = useWorkspace(row?.workspaceId ?? "");
  const url = useBrowserOpenUrl(sessionId);
  const tab = (useSearch({ strict: false }) as { tab?: string }).tab;
  const open = useEffectEvent((id: string) => {
    if (id !== sessionId) return;
    void navigate({
      search: (p: Record<string, unknown>) => ({ ...p, tab: "browser" }),
      transition: "none",
    } as never);
  });
  useEffect(() => {
    const unregister = registerBrowserOpen(({ sessionId }) => open(sessionId));
    return () => unregister();
  }, []);
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
