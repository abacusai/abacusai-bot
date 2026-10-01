/**
 * Sidebar per area (spec 01 §7.3): the one place allowed to import several
 * features' public sidebar exports.
 */
import { createElement, Fragment, type ComponentType } from "react";

import { ArtifactsSidebar } from "#renderer/features/artifacts";
import { BotsNeedsYou, BotsSidebar } from "#renderer/features/bots";
import { LibrarySidebar } from "#renderer/features/library";
import { RoutinesSidebar, RoutinesNeedsYou } from "#renderer/features/routines";
import { SessionsSidebar } from "#renderer/features/sessions";
import { SettingsSidebar } from "#renderer/features/settings";

import type { ShellArea } from "./layout";

export const SIDEBARS: Record<ShellArea, ComponentType> = {
  bots: BotsSidebar,
  sessions: SessionsSidebar,
  routines: RoutinesSidebar,
  artifacts: ArtifactsSidebar,
  library: LibrarySidebar,
  settings: SettingsSidebar,
};

export { BotsStrip } from "#renderer/features/bots";

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
