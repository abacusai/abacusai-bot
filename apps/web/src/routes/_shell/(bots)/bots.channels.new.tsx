import { createFileRoute } from "@tanstack/react-router";

import { NewGroupPage } from "#renderer/features/bots/channels/pages";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";

const NewChannel = () => <NewGroupPage TopBar={TopBarSlot} />;

/** A new channel: name, purpose, the bots, then the first message. */
export const Route = createFileRoute("/_shell/(bots)/bots/channels/new")({
  component: NewChannel,
});
