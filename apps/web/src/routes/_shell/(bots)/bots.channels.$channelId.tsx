import { createFileRoute } from "@tanstack/react-router";
import { lazy, type ComponentProps, type ReactNode } from "react";

import {
  ChannelMarkdown,
  GroupPage,
  NEW_CHANNEL,
  NewGroupPage,
  type ChannelMarkdownView,
} from "#renderer/features/bots/channels/pages";
import {
  openPanelTab,
  panelScopeKey,
  setPanelOpen,
} from "#renderer/features/shell/panel-store";
import { SidePanelContent } from "#renderer/features/shell/side-panel-slot";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";
import { activeTabOf, usePanelScope } from "#renderer/features/shell/use-panel";

/** The chat's Markdown for channel messages; bots' text renders untrusted. */
const Markdown: ChannelMarkdownView = lazy(() =>
  import("#renderer/features/chat/markdown/markdown").then((m) => ({
    default: ({
      text,
      role,
      openExternal,
    }: ComponentProps<ChannelMarkdownView>) => (
      <m.MarkdownLinksProvider value={{ openFile: () => {}, openExternal }}>
        <m.Markdown content={text} role={role} untrusted />
      </m.MarkdownLinksProvider>
    ),
  }))
);

/** The channel's details fill the shell's "details" tab, as a bot's do. */
const ChannelSidePanel = ({ children }: { children: ReactNode }) => (
  <SidePanelContent kind="details">{children}</SidePanelContent>
);

const Channel = ({ channelId }: { channelId: string }) => {
  // The panel's state is the channel's, in the shell's store (one scope per
  // channel), toggled from the title the way a bot's identity toggles its own.
  const panelKey = panelScopeKey("bots", `channel:${channelId}`)!;
  const panel = usePanelScope(panelKey);
  const open = panel.open && activeTabOf(panel)?.kind === "details";
  const toggle = (): void => {
    if (open) setPanelOpen(panelKey, false);
    else openPanelTab(panelKey, { kind: "details" });
  };
  return (
    <ChannelMarkdown value={Markdown}>
      <GroupPage
        key={channelId}
        channelId={channelId}
        TopBar={TopBarSlot}
        details={{ open, toggle }}
        SidePanel={ChannelSidePanel}
      />
    </ChannelMarkdown>
  );
};

const ChannelRoute = () => {
  const { channelId } = Route.useParams();
  // One route for both: the pages share their parts, and a second route
  // would split them into chunks of their own.
  if (channelId === NEW_CHANNEL) return <NewGroupPage TopBar={TopBarSlot} />;
  return <Channel channelId={channelId} />;
};

/** A channel: the user and several bots in one thread; `new` starts one. */
export const Route = createFileRoute("/_shell/(bots)/bots/channels/$channelId")(
  {
    component: ChannelRoute,
  }
);
