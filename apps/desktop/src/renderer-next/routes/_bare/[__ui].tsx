import { createFileRoute, notFound } from "@tanstack/react-router";

import { SoundSynthesisProbe } from "#next/components/sound-preview/probe";
import {
  ArtifactsPage,
  artifactGalleryRows,
  ArtifactsStressGallery,
} from "#next/features/artifacts";
import {
  useBot,
  useBotChatSlots,
  BotTranscriptIdentity,
} from "#next/features/bots";
import { botsGallerySections, isBotsGalleryFixture } from "#next/features/bots";
import {
  useComposerExpanded,
  ChatView,
  loadFixtureRuntime,
} from "#next/features/chat";
import { chatGallerySections } from "#next/features/chat";
import { Gallery, GallerySearch, galleryEnabled } from "#next/features/gallery";
import { ConnectorsPage } from "#next/features/library";
import {
  Phase5GalleryNav,
  phase5FixtureIds,
  RoutineSidebarGallery,
  RunReportFrame,
} from "#next/features/routines";
import {
  GeneralPage,
  ModelsPage,
  NotificationsPage,
  KeyboardPage,
} from "#next/features/settings";

type Replay = ReturnType<Awaited<ReturnType<typeof loadFixtureRuntime>>>;
let replay: Replay = null;
let reportReplay: Replay = null;
const replayReady =
  import.meta.env.VITE_NEXT_DB_FIXTURES === "1"
    ? loadFixtureRuntime().then((create) => {
        replay = create("bot-golden-plain", {}, "bots-gallery");
        reportReplay = create("bot-golden-plain", {}, "routine-gallery-report");
      })
    : null;
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
      <Phase5GalleryNav {...props} />
      <botsGallerySections.Nav {...props} />
      <chatGallerySections.Nav {...props} />
    </>
  ),
  View: (props: {
    fixture: string;
    step: number | undefined;
    play: boolean;
  }) =>
    phase5FixtureIds.some((id) => id === props.fixture) ? (
      <Phase5View fixture={props.fixture} />
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
  loader: async () => {
    if (replayReady != null) await replayReady;
  },
  validateSearch: GallerySearch,
  component: GalleryRoute,
});

function Phase5View({ fixture }: { fixture: string }) {
  const components: Record<string, React.ReactNode> = {
    "routines-sidebar": <RoutineSidebarGallery />,
    "artifacts-grid": <ArtifactsPage fixtureRows={artifactGalleryRows} />,
    "artifacts-stress": <ArtifactsStressGallery />,
    "sound-synthesis": <SoundSynthesisProbe />,
    "library-connectors": <ConnectorsPage />,
    "settings-general": <GeneralPage />,
    "settings-models": <ModelsPage />,
    "settings-notifications": <NotificationsPage />,
    "settings-keyboard": <KeyboardPage />,
    "routine-report": reportReplay ? (
      <RunReportFrame runId="routine-gallery-report" onClose={() => {}}>
        <ChatView
          threadId="routine-gallery-report"
          runtime={reportReplay.runtime}
          skin="bot"
          workspaceRoot={null}
          composer={{
            mode: "full",
            placeholder: "",
            attachmentsBase: null,
            showModeChip: false,
            model: null,
            readOnly: { reason: "This run is read-only" },
          }}
          slots={{
            decorateMessage: (m, c) => ({
              hidden: m.role === "user" && c.index === 0,
            }),
          }}
        />
      </RunReportFrame>
    ) : null,
  };
  return <div className="h-[650px]">{components[fixture]}</div>;
}
