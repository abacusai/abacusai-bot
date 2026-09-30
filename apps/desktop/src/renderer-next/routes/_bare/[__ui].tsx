import { createFileRoute, notFound } from "@tanstack/react-router";

import {
  useBot,
  useBotChatSlots,
  BotTranscriptIdentity,
} from "#next/features/bots";
import { botsGallerySections, isBotsGalleryFixture } from "#next/features/bots";
import {
  useComposerExpanded,
  ChatView,
  fixtureRuntime,
} from "#next/features/chat";
import { chatGallerySections } from "#next/features/chat";
import { Gallery, GallerySearch, galleryEnabled } from "#next/features/gallery";
import {
  sessionsGallerySections,
  isSessionsGalleryFixture,
} from "#next/features/sessions";

const replay = fixtureRuntime("bot-golden-plain", {}, "bots-gallery");
const BotChatGallery = () => {
  const bot = useBot("chief-of-staff");
  return bot ? <GalleryChat bot={bot} /> : null;
};
const GalleryChat = ({
  bot,
}: {
  bot: NonNullable<ReturnType<typeof useBot>>;
}) => {
  const expanded = useComposerExpanded("bots-gallery");
  const slots = useBotChatSlots(bot, "bots-gallery", expanded);
  return replay ? (
    <div className="h-[650px]">
      <ChatView
        threadId="bots-gallery"
        runtime={replay.runtime}
        skin="bot"
        workspaceRoot={slots.workspaceRoot}
        composer={slots.composer}
        slots={{
          ...slots.chat,
          header: (
            <BotTranscriptIdentity
              bot={bot}
              onDock={() => {}}
              onToggle={() => {}}
              detailsOpen={false}
            />
          ),
        }}
      />
    </div>
  ) : null;
};
const extension = {
  Nav: (props: { fixture: string | undefined }) => (
    <>
      <sessionsGallerySections.Nav {...props} />
      <botsGallerySections.Nav {...props} />
      <chatGallerySections.Nav {...props} />
    </>
  ),
  View: (props: {
    fixture: string;
    step: number | undefined;
    play: boolean;
  }) =>
    isSessionsGalleryFixture(props.fixture) ? (
      <sessionsGallerySections.View {...props} />
    ) : props.fixture === "bots-chat" ? (
      <BotChatGallery />
    ) : isBotsGalleryFixture(props.fixture) ? (
      <botsGallerySections.View {...props} />
    ) : (
      <chatGallerySections.View {...props} />
    ),
};
const GalleryRoute = () => {
  const search = Route.useSearch();
  return <Gallery search={search} extension={extension} />;
};

/** The dev gallery (spec 01 §10): dev builds and VITE_UI_GALLERY=1 only. */
export const Route = createFileRoute("/_bare/__ui")({
  beforeLoad: () => {
    if (!galleryEnabled()) throw notFound();
  },
  validateSearch: GallerySearch,
  component: GalleryRoute,
});
