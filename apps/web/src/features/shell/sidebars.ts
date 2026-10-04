/**
 * Sidebar per area (spec 01 §7.3): the one place allowed to import several
 * features' public sidebar exports.
 */
import {
  createElement,
  Fragment,
  lazy,
  Suspense,
  type ComponentType,
} from "react";

const LazyArtifactsSidebar = lazy(() =>
  import("#renderer/features/artifacts").then((m) => ({
    default: m.ArtifactsSidebar,
  }))
);
const ArtifactsSidebar = () =>
  createElement(
    Suspense,
    { fallback: null },
    createElement(LazyArtifactsSidebar)
  );
import {
  BotsNeedsYou,
  BotsSidebar,
} from "#renderer/features/bots/sidebar/bots-sidebar";
const LazyLibrarySidebar = lazy(() =>
  import("#renderer/features/library").then((m) => ({
    default: m.LibrarySidebar,
  }))
);
const LibrarySidebar = () =>
  createElement(
    Suspense,
    { fallback: null },
    createElement(LazyLibrarySidebar)
  );
import {
  RoutinesSidebar,
  RoutinesNeedsYou,
} from "#renderer/features/routines/sidebar";
import { SessionsSidebar } from "#renderer/features/sessions/sessions-sidebar";
const LazySettingsSidebar = lazy(() =>
  import("#renderer/features/settings").then((m) => ({
    default: m.SettingsSidebar,
  }))
);
const SettingsSidebar = () =>
  createElement(
    Suspense,
    { fallback: null },
    createElement(LazySettingsSidebar)
  );

import type { ShellArea } from "./layout";

export const SIDEBARS: Record<ShellArea, ComponentType> = {
  bots: BotsSidebar,
  sessions: SessionsSidebar,
  routines: RoutinesSidebar,
  artifacts: ArtifactsSidebar,
  library: LibrarySidebar,
  settings: SettingsSidebar,
};

export { BotsStrip } from "#renderer/features/bots/sidebar/bots-sidebar";

/**
 * The "Needs you" slot above another area's sidebar (spec 01 §7.2; 03
 * §7.2): bots now, sessions join in phase 4.
 */
const CombinedNeedsYou = () =>
  createElement(
    Fragment,
    null,
    createElement(BotsNeedsYou),
    createElement(RoutinesNeedsYou)
  );

export const NEEDS_YOU: Partial<Record<ShellArea, ComponentType>> = {
  bots: RoutinesNeedsYou,
  sessions: CombinedNeedsYou,
  routines: CombinedNeedsYou,
  artifacts: CombinedNeedsYou,
  library: CombinedNeedsYou,
};
