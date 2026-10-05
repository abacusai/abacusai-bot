import { createFileRoute, notFound, Link } from "@tanstack/react-router";

import { SoundSynthesisProbe } from "#renderer/components/sound-preview/probe";
import {
  ArtifactsPage,
  ArtifactsStressGallery,
} from "#renderer/features/artifacts";
import { artifactGalleryRows } from "#renderer/features/artifacts/gallery";
import { BotTranscriptIdentity } from "#renderer/features/bots/chat/identity";
import { useBotChatSlots } from "#renderer/features/bots/chat/slots";
import { useBot } from "#renderer/features/bots/data/queries";
import {
  botsGallerySections,
  isBotsGalleryFixture,
} from "#renderer/features/bots/gallery/sections";
import { loadFixtureRuntime } from "#renderer/features/chat";
import { chatGallerySections } from "#renderer/features/chat";
import { useComposerExpanded } from "#renderer/features/chat/composer/composer";
import { ChatView } from "#renderer/features/chat/kit/lazy-view";
import { Gallery } from "#renderer/features/gallery/gallery";
import {
  GallerySearch,
  galleryEnabled,
} from "#renderer/features/gallery/search";
import { ConnectorsPage } from "#renderer/features/library/connectors";
import { NotchGallery } from "#renderer/features/notch/gallery";
import { OnboardingGallery } from "#renderer/features/onboarding/gallery";
import {
  Phase5GalleryNav,
  phase5FixtureIds,
  RoutineSidebarGallery,
} from "#renderer/features/routines/gallery";
import { RunReportFrame } from "#renderer/features/routines/page";
import {
  sessionsGallerySections,
  isSessionsGalleryFixture,
} from "#renderer/features/sessions/gallery/sections";
import { KeyboardPage } from "#renderer/features/settings/keyboard";
import { ModelsPage } from "#renderer/features/settings/models";
import {
  GeneralPage,
  NotificationsPage,
} from "#renderer/features/settings/personal";
import { TourGallery } from "#renderer/features/tour/gallery";
import {
  ONBOARDING_STEPS,
  type OnboardingStepId,
} from "#renderer/lib/navigation/areas";

type Replay = ReturnType<Awaited<ReturnType<typeof loadFixtureRuntime>>>;
const replayState = { current: null as Replay };
const reportReplayState = { current: null as Replay };
const replayReady =
  import.meta.env.VITE_NEXT_DB_FIXTURES === "1"
    ? loadFixtureRuntime().then((create) => {
        replayState.current = create("bot-golden-plain", {}, "bots-gallery");
        reportReplayState.current = create(
          "bot-golden-plain",
          {},
          "routine-gallery-report"
        );
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
  return replayState.current ? (
    <div className="h-[calc(100dvh-180px)] min-h-64">
      <ChatView
        threadId="bots-gallery"
        runtime={replayState.current.runtime}
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
      <Phase5GalleryNav {...props} />
      <div className="my-3 font-semibold">
        {"Phase 6" /* i18n-ignore: dev-only gallery label */}
      </div>
      {[
        ...ONBOARDING_STEPS.map((step) => `onboarding-${step}`),
        "tour",
        ...[
          "idle",
          "working",
          "approval",
          "question",
          "reply",
          "call",
          "done",
          "failed",
        ].map((state) => `notch-${state}`),
      ].map((fixture) => (
        <Link
          key={fixture}
          to="/__ui"
          search={{ fixture }}
          className="block py-1 text-xs"
        >
          {fixture}
        </Link>
      ))}
      <botsGallerySections.Nav {...props} />
      <chatGallerySections.Nav {...props} />
    </>
  ),
  View: (props: {
    fixture: string;
    step: number | undefined;
    play: boolean;
  }) =>
    props.fixture.startsWith("onboarding-") ? (
      <OnboardingGallery step={props.fixture.slice(11) as OnboardingStepId} />
    ) : props.fixture.startsWith("notch-") ? (
      <NotchGallery state={props.fixture.slice(6)} />
    ) : props.fixture.startsWith("tour") ? (
      <TourGallery stop={props.fixture.slice(5) || "welcome"} />
    ) : isSessionsGalleryFixture(props.fixture) ? (
      <sessionsGallerySections.View {...props} />
    ) : phase5FixtureIds.some((id) => id === props.fixture) ? (
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
    "routine-report": reportReplayState.current ? (
      <RunReportFrame runId="routine-gallery-report" onClose={() => {}}>
        <ChatView
          threadId="routine-gallery-report"
          runtime={reportReplayState.current.runtime}
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
  return (
    <div className="h-[calc(100dvh-180px)] min-h-64">{components[fixture]}</div>
  );
}
