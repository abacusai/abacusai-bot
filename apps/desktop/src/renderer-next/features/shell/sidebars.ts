/**
 * Sidebar per area (spec 01 §7.3): the one place allowed to import several
 * features' public sidebar exports.
 */
import type { ComponentType } from "react";

import { ArtifactsSidebar } from "#next/features/artifacts";
import { BotsSidebar } from "#next/features/bots";
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
