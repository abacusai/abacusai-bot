import { createFileRoute } from "@tanstack/react-router";
import { lazy, type ComponentProps } from "react";

import {
  ChannelMarkdown,
  GroupPage,
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
  return (
    <ChannelMarkdown value={Markdown}>
      <GroupPage key={channelId} channelId={channelId} TopBar={TopBarSlot} />
    </ChannelMarkdown>
  );
};

/** A channel: the user and several bots in one thread. */
export const Route = createFileRoute("/_shell/(bots)/bots/channels/$channelId")(
  {
    component: ChannelRoute,
  }
);
