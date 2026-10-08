import { BOT_AVATAR_COLORS } from "@abacus-ai/contract/bots";
/**
 * `/__ui` (spec 01 §10): every token, every atom, the shell parts, the
 * occlusion watcher's output and the view-transition types, one theme at a
 * time applied to the whole document (so portals match, Codex r1 #21), one
 * overlay open at a time (`?open=`). Dev-only English.
 */
import { useNavigate } from "@tanstack/react-router";
import { useStore } from "@tanstack/react-store";
import {
  addTransitionType,
  startTransition,
  useEffect,
  useState,
  ViewTransition,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  type ViewTransitionClassPerType,
} from "react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "#renderer/components/empty-state";
import { NavList } from "#renderer/components/nav-list";
import type { PanelTab } from "#renderer/features/shell/panel-store";
import { Rail } from "#renderer/features/shell/rail";
import { shellStore } from "#renderer/features/shell/shell-store";
import {
  SidePanelBody,
  SidePanelFrame,
} from "#renderer/features/shell/side-panel";
import { TopBar } from "#renderer/features/shell/top-bar";
import { cn } from "#renderer/lib/cn";
import { NAV_TYPES, durations, type NavType } from "#renderer/lib/motion";
import { AREA_HOME, RAIL_AREAS } from "#renderer/lib/navigation/areas";
import { useSharedElementName } from "#renderer/lib/navigation/shared-element";
import {
  accentForeground,
  contrastRatio,
  holdTheme,
} from "#renderer/lib/theme";
import { Button } from "#renderer/ui/button";

import * as Atoms from "./atoms";

const GALLERY_PANEL_TABS: PanelTab[] = [
  { id: "memory:1", kind: "memory" },
  { id: "files:1", kind: "files" },
  { id: "browser:1", kind: "browser", title: "news.example.com" },
  { id: "details:1", kind: "details" },
];
import {
  OverlayContext,
  OverlayExample,
  RowStatesExample,
  OVERLAY_EXAMPLES,
} from "./overlays";
import {
  GALLERY_OVERLAY_IDS,
  GALLERY_SECTIONS,
  OVERLAY_SECTION,
  type GalleryOverlayId,
  type GallerySearchValue,
  type GallerySection,
} from "./search";

const Section = ({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) => (
  <section
    id={`section-${id}`}
    data-gallery-section={id}
    aria-labelledby={`section-${id}-title`}
    className="border-border flex flex-col gap-4 border-b py-8"
  >
    <h2 id={`section-${id}-title`} className="text-sm font-semibold">
      {title}
    </h2>
    <div className="flex flex-col gap-4">{children}</div>
  </section>
);

const COLOR_TOKENS = [
  ["background", "foreground"],
  ["card", "card-foreground"],
  ["popover", "popover-foreground"],
  ["primary", "primary-foreground"],
  ["secondary", "secondary-foreground"],
  ["muted", "muted-foreground"],
  ["accent", "accent-foreground"],
  ["destructive", "primary-foreground"],
  ["sidebar", "sidebar-foreground"],
  ["sidebar-accent", "sidebar-accent-foreground"],
  ["sidebar-primary", "sidebar-primary-foreground"],
] as const;

const TokensSection = () => (
  <>
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
      {COLOR_TOKENS.map(([surface, text]) => (
        <div
          key={surface}
          data-token={surface}
          className="flex h-16 flex-col justify-between rounded-md border p-2 text-[11px]"
          style={{ background: `var(--${surface})`, color: `var(--${text})` }}
        >
          <span className="font-medium">--{surface}</span>
          <span>on --{text}</span>
        </div>
      ))}
    </div>
    <Atoms.Row label="bot accents (foreground by WCAG ratio)">
      {BOT_AVATAR_COLORS.map((swatch) => (
        <span
          key={swatch}
          className="rounded-md px-2 py-1 text-[11px] font-medium"
          style={{ background: swatch, color: accentForeground(swatch) }}
        >
          {contrastRatio(swatch, accentForeground(swatch)).toFixed(2)}
        </span>
      ))}
    </Atoms.Row>
    <Atoms.Row label="radius">
      {["sm", "md", "lg", "xl", "2xl"].map((radius) => (
        <span
          key={radius}
          className="bg-muted flex size-12 items-center justify-center border text-[10px]"
          style={{ borderRadius: `var(--radius-${radius})` }}
        >
          {radius}
        </span>
      ))}
    </Atoms.Row>
    <Atoms.Row label="geometry">
      {[
        "--toolbar-h",
        "--rail-w",
        "--sidebar-w",
        "--sidebar-strip-w",
        "--side-panel-min",
        "--side-panel-drawer-w",
        "--pane-inset",
        "--pane-radius",
        "--row-h",
      ].map((name) => (
        <code key={name} className="bg-muted rounded px-1.5 py-0.5 text-[11px]">
          {name}
        </code>
      ))}
    </Atoms.Row>
  </>
);

/** Simulated chrome modes (canvas page 5): inline reservations on a frame. */
const CHROME_MODES = [
  {
    id: "mac",
    label: "macOS (lights 70 px)",
    style: { "--titlebar-x": "70px", "--titlebar-end": "0px" },
  },
  {
    id: "windows",
    label: "Windows (buttons 138 px)",
    style: { "--titlebar-x": "0px", "--titlebar-end": "138px" },
  },
  {
    id: "native-frame",
    label: "Native frame",
    style: { "--titlebar-x": "0px", "--titlebar-end": "0px" },
  },
  {
    id: "fullscreen",
    label: "Fullscreen",
    style: { "--titlebar-x": "0px", "--titlebar-end": "0px" },
  },
] as const;

const TopBarFrame = ({
  pinned,
  panel,
  mode,
}: {
  pinned: boolean;
  panel: boolean;
  mode: (typeof CHROME_MODES)[number];
}) => (
  <div
    data-chrome-mode={mode.id}
    className="bg-sidebar text-sidebar-foreground relative overflow-hidden rounded-md border"
    style={
      {
        ...mode.style,
        "--sidebar-occupied-w": pinned ? "280px" : "0px",
      } as Record<string, string> as CSSProperties
    }
  >
    <TopBar.Root>
      <TopBar.Leading
        sidebarInLayout={pinned}
        showAppName={pinned}
        onToggleSidebar={() => undefined}
      />
      <TopBar.Identity status statusText="Ready">
        <span className="text-sidebar-foreground truncate font-medium">
          Morning Brief
        </span>
      </TopBar.Identity>
      {panel && (
        <TopBar.PanelTabs
          tabs={GALLERY_PANEL_TABS}
          active="memory:1"
          title={(tab) => tab.title ?? tab.kind}
          kinds={["details", "memory", "files", "browser"]}
          onChange={() => undefined}
          onClose={() => undefined}
          onReorder={() => undefined}
          onAdd={() => undefined}
        />
      )}
      <TopBar.PanelToggle open={panel} onToggle={() => undefined} />
    </TopBar.Root>
  </div>
);

const ShellSection = () => {
  const { t } = useTranslation();
  return (
    <>
      <Atoms.Row label="rail × active item">
        {[...RAIL_AREAS, "settings" as const].map((area) => (
          <div
            key={area}
            className="bg-sidebar h-[420px] overflow-hidden rounded-md border"
          >
            <Rail
              area={area}
              floatingEnabled={false}
              label={`Rail, ${area} active`}
            />
          </div>
        ))}
      </Atoms.Row>
      {CHROME_MODES.map((mode) => (
        <div key={mode.id} className="flex flex-col gap-2">
          <span className="text-muted-foreground text-[11px]">
            {mode.label}
          </span>
          {[true, false].map((pinned) =>
            [false, true].map((panel) => (
              <TopBarFrame
                key={`${pinned}-${panel}`}
                pinned={pinned}
                panel={panel}
                mode={mode}
              />
            ))
          )}
        </div>
      ))}
      <Atoms.Row label="sidebar states">
        <div className="bg-sidebar h-64 w-[280px] overflow-hidden rounded-md border pt-2">
          <NavList.Root label="Loading">
            <NavList.Header title="Loading" />
            <NavList.Skeleton />
          </NavList.Root>
        </div>
        <div className="bg-sidebar h-64 w-[280px] overflow-hidden rounded-md border pt-2">
          <NavList.Root label="Empty">
            <NavList.Header title="Empty" />
            <p className="text-muted-foreground px-2 pt-2 text-xs">
              {t("bots.sidebar.empty")}
            </p>
          </NavList.Root>
        </div>
        <div className="bg-sidebar h-64 w-[280px] overflow-hidden rounded-md border pt-2">
          <NavList.Root label="Error">
            <NavList.Header title="Error" />
            <NavList.Error
              message={t("shell.sidebar.loadError")}
              retryLabel={t("shell.sidebar.retry")}
              onRetry={() => undefined}
            />
          </NavList.Root>
        </div>
        <div className="border-sidebar-border bg-sidebar h-64 w-[280px] overflow-hidden rounded-md border pt-2 shadow-[0_24px_64px_rgb(0_0_0/0.18)]">
          <NavList.Root label="Floating">
            <NavList.Header title="Floating" />
            <NavList.Item
              to="/sessions/new"
              title="Review my pull requests"
              active
            />
            <NavList.Item to="/sessions/new" title="Compress the installers" />
          </NavList.Root>
        </div>
      </Atoms.Row>
      <Atoms.Row label="side panel in layout">
        <div className="bg-sidebar flex h-56 w-[400px] rounded-md border p-2">
          <SidePanelFrame>
            <SidePanelBody tab={{ id: "terminal:1", kind: "terminal" }} />
          </SidePanelFrame>
        </div>
      </Atoms.Row>
      <Atoms.Row label="empty state per area">
        {(
          [
            "bots",
            "sessions",
            "routines",
            "artifacts",
            "library",
            "settings",
          ] as const
        ).map((area) => (
          <div key={area} className="bg-background w-64 rounded-md border">
            <EmptyState
              icon={area}
              title={t(`shell.rail.${area}`)}
              description={AREA_HOME[area]}
            />
          </div>
        ))}
      </Atoms.Row>
    </>
  );
};

const OcclusionSection = () => {
  const rects = useStore(shellStore, (state) => state.occlusion.rects);
  return (
    <>
      <div
        className="bg-muted/40 text-muted-foreground relative flex h-40 items-center justify-center gap-3 rounded-md border border-dashed text-xs"
        data-testid="fake-native-surface"
      >
        Fake native surface
        <OVERLAY_EXAMPLES.popover />
        <OVERLAY_EXAMPLES.dialog />
        <Atoms.ToastSection />
      </div>
      <p
        className="text-muted-foreground text-xs"
        data-testid="occlusion-count"
      >
        {rects.length} occluding rect(s)
      </p>
      {rects.map((rect) => (
        <div
          key={`${rect.x}-${rect.y}-${rect.width}-${rect.height}`}
          aria-hidden="true"
          className="pointer-events-none fixed z-[60] border-2 border-dashed border-red-500"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
          }}
        />
      ))}
    </>
  );
};

/**
 * An in-route state change React commits itself (spec 01 §6.7 amendment):
 * the one place a React `<ViewTransition>` plays in phase 1. Route changes
 * are the router's document transition, never this.
 */
const MOTION_VT: ViewTransitionClassPerType = {
  "nav-lateral": "pane",
  "nav-forward": "pane",
  "nav-back": "pane",
  "settings-in": "pane",
  "settings-out": "pane",
  default: "none",
};

const MotionSection = () => {
  const [pane, setPane] = useState(0);
  // A cross-route shared element takes a CSS name (spec 01 §6.7).
  const shared = useSharedElementName("gallery-shared-dot");
  return (
    <>
      <Atoms.Row label="shared element (CSS view-transition-name)">
        <span
          data-testid="gallery-shared-dot"
          className="bg-primary size-4 rounded-full"
          style={shared}
        />
      </Atoms.Row>
      <Atoms.Row label={`view-transition types (${durations.route} ms)`}>
        {NAV_TYPES.map((type: NavType) => (
          <Button
            key={type}
            variant="outline"
            size="sm"
            onClick={() =>
              startTransition(() => {
                addTransitionType(type);
                setPane((value) => value + 1);
              })
            }
          >
            {type}
          </Button>
        ))}
      </Atoms.Row>
      <div className="relative h-32 w-80 overflow-hidden rounded-md border">
        <ViewTransition
          key={pane}
          enter={MOTION_VT}
          exit={MOTION_VT}
          default="none"
        >
          <div
            className={cn(
              "pane flex size-full items-center justify-center text-sm",
              pane % 2 === 0 ? "bg-background" : "bg-muted"
            )}
          >
            Pane {pane}
          </div>
        </ViewTransition>
      </div>
    </>
  );
};

const ATOM_RENDERERS: Partial<Record<GallerySection, () => ReactNode>> = {
  button: Atoms.ButtonSection,
  badge: Atoms.BadgeSection,
  tabs: Atoms.TabsSection,
  resizable: Atoms.ResizableSection,
  "scroll-area": Atoms.ScrollAreaSection,
  kbd: Atoms.KbdSection,
  field: Atoms.FieldSection,
  label: Atoms.LabelSection,
  input: Atoms.InputSection,
  "input-group": Atoms.InputGroupSection,
  textarea: Atoms.TextareaSection,
  item: Atoms.ItemSection,
  empty: Atoms.EmptySection,
  spinner: Atoms.SpinnerSection,
  skeleton: Atoms.SkeletonSection,
  separator: Atoms.SeparatorSection,
  avatar: Atoms.AvatarSection,
  toggle: Atoms.ToggleSection,
  "toggle-group": Atoms.ToggleGroupSection,
  switch: Atoms.SwitchSection,
  "native-select": Atoms.NativeSelectSection,
  toast: Atoms.ToastSection,
  "message-scroller": Atoms.MessageScrollerSection,
  message: Atoms.MessageSection,
  bubble: Atoms.BubbleSection,
  attachment: Atoms.AttachmentSection,
  marker: Atoms.MarkerSection,
  questionnaire: Atoms.QuestionnaireSection,
  collapsible: Atoms.CollapsibleSection,
  tokens: TokensSection,
  shell: ShellSection,
  occlusion: OcclusionSection,
  motion: MotionSection,
};

const renderSection = (section: GallerySection): ReactNode => {
  const overlays = GALLERY_OVERLAY_IDS.filter(
    (id) => OVERLAY_SECTION[id] === section
  );
  const Renderer = ATOM_RENDERERS[section];
  return (
    <>
      {Renderer != null && <Renderer />}
      {section === "item" && <RowStatesExample />}
      {overlays.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {overlays.map((id) => {
            return <OverlayExample key={id} id={id} />;
          })}
        </div>
      )}
    </>
  );
};

/**
 * Sections another feature contributes (spec 02 §14.8): its nav entries and,
 * when its `fixture` search param is set, the view shown in place of the
 * sections. The route composes them; the gallery imports no feature.
 */
export interface GalleryExtension {
  Nav: ComponentType<{ fixture: string | undefined }>;
  View: ComponentType<{
    fixture: string;
    step: number | undefined;
    play: boolean;
  }>;
}

export const Gallery = ({
  search,
  extension,
}: {
  search: GallerySearchValue;
  extension?: GalleryExtension;
}) => {
  const navigate = useNavigate({ from: "/__ui" });
  const setSearch = (patch: Partial<GallerySearchValue>): void =>
    void navigate({
      to: "/__ui",
      search: (previous: GallerySearchValue) => ({ ...previous, ...patch }),
      replace: true,
    });

  // One theme for the whole document while the gallery is mounted.
  useEffect(
    () => (search.theme === "app" ? undefined : holdTheme(search.theme)),
    [search.theme]
  );

  const sections: readonly GallerySection[] =
    search.section == null ? GALLERY_SECTIONS : [search.section];

  return (
    <OverlayContext
      value={{
        open: search.open,
        stress: search.stress,
        setOpen: (id: GalleryOverlayId | undefined) => setSearch({ open: id }),
      }}
    >
      <div className="bg-background text-foreground flex h-dvh flex-col">
        <div className="h-(--toolbar-h) shrink-0" />
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Gallery sections"
            className="titlebar-nodrag w-48 shrink-0 overflow-y-auto border-r px-2 py-3"
          >
            <div className="mb-3 flex gap-1" role="group" aria-label="Theme">
              {(["app", "light", "dark"] as const).map((theme) => (
                <Button
                  key={theme}
                  size="xs"
                  variant={search.theme === theme ? "secondary" : "ghost"}
                  onClick={() => setSearch({ theme })}
                >
                  {theme}
                </Button>
              ))}
            </div>
            <ul className="flex flex-col gap-0.5 text-xs">
              <li>
                <button
                  type="button"
                  className="hover:bg-muted w-full rounded px-2 py-1 text-left"
                  onClick={() =>
                    setSearch({ section: undefined, open: undefined })
                  }
                >
                  all
                </button>
              </li>
              {GALLERY_SECTIONS.map((section) => (
                <li key={section}>
                  <button
                    type="button"
                    aria-current={
                      search.section === section ? "true" : undefined
                    }
                    className="hover:bg-muted aria-[current=true]:bg-muted w-full rounded px-2 py-1 text-left"
                    onClick={() => setSearch({ section, open: undefined })}
                  >
                    {section}
                  </button>
                </li>
              ))}
            </ul>
            {extension != null ? (
              <extension.Nav fixture={search.fixture} />
            ) : null}
          </nav>
          <main
            className="min-w-0 flex-1 overflow-y-auto px-8"
            data-testid="gallery"
          >
            {extension != null && search.fixture != null ? (
              <extension.View
                key={`${search.fixture}:${search.step ?? ""}:${search.play ?? ""}`}
                fixture={search.fixture}
                step={search.step}
                play={search.play != null}
              />
            ) : (
              <>
                <h1 className="pt-6 text-lg font-semibold">UI gallery</h1>
                {sections.map((section) => (
                  <Section key={section} id={section} title={section}>
                    {renderSection(section)}
                  </Section>
                ))}
              </>
            )}
          </main>
        </div>
      </div>
    </OverlayContext>
  );
};
