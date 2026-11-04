import { createFileRoute } from "@tanstack/react-router";
import { lazy, type ComponentProps } from "react";

import {
  ChannelMarkdown,
  GroupPage,
  NEW_CHANNEL,
  NewGroupPage,
  type ChannelMarkdownView,
} from "#renderer/features/bots/channels/pages";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";

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

const ChannelRoute = () => {
  const { channelId } = Route.useParams();
  // One route for both: the pages share their parts, and a second route
  // would split them into chunks of their own.
  if (channelId === NEW_CHANNEL) return <NewGroupPage TopBar={TopBarSlot} />;
  return (
    <ChannelMarkdown value={Markdown}>
      <GroupPage key={channelId} channelId={channelId} TopBar={TopBarSlot} />
    </ChannelMarkdown>
  );
};

/** A channel: the user and several bots in one thread; `new` starts one. */
export const Route = createFileRoute("/_shell/(bots)/bots/channels/$channelId")(
  {
    component: ChannelRoute,
  }
);
