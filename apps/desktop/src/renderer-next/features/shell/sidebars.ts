/**
 * Sidebar per area (spec 01 §7.3): the one place allowed to import several
 * features' public sidebar exports.
 */
import type { ComponentType } from "react";

import { ArtifactsSidebar } from "#next/features/artifacts";
import { BotsNeedsYou, BotsSidebar } from "#next/features/bots";
import { LibrarySidebar } from "#next/features/library";
import { RoutinesSidebar } from "#next/features/routines";
import { SessionsSidebar } from "#next/features/sessions";
import { SettingsSidebar } from "#next/features/settings";

import type { ShellArea } from "./layout";

export const SIDEBARS: Record<ShellArea, ComponentType> = {
  bots: BotsSidebar,
  sessions: SessionsSidebar,
  routines: RoutinesSidebar,
  artifacts: ArtifactsSidebar,
  library: LibrarySidebar,
  settings: SettingsSidebar,
};

export { BotsStrip } from "#next/features/bots";

/**
 * The "Needs you" slot above another area's sidebar (spec 01 §7.2; 03
 * §7.2): bots now, sessions join in phase 4.
 */
export const NEEDS_YOU: Partial<Record<ShellArea, ComponentType>> = {
  sessions: BotsNeedsYou,
  routines: BotsNeedsYou,
  artifacts: BotsNeedsYou,
  library: BotsNeedsYou,
};
