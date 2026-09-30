/**
 * Search schemas (spec 01 §6.2). Every field falls back instead of throwing,
 * so a bad or stale URL still opens; defaults are stripped from built links.
 * Ids reuse the contract's atoms so URLs and procedure inputs share one rule.
 */
import * as v from "valibot";

import { SessionId, WorkspaceId } from "#shared/contract/ids";

/** Optional; an invalid value falls back to absent instead of throwing. */
export const optionalField = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(
  schema: TSchema
) => v.fallback(v.optional(schema), undefined);

export const SIDE_PANEL_TABS = [
  "changes",
  "terminal",
  "files",
  "browser",
  "memory",
  "details",
  "agent",
] as const;
export const SidePanelTab = v.picklist(SIDE_PANEL_TABS);
export type SidePanelTabId = v.InferOutput<typeof SidePanelTab>;

export const ShellSearch = v.object({
  /** The side panel is open on this tab; absent = closed. */
  tab: optionalField(SidePanelTab),
});
export const SHELL_DEFAULTS = {} as const;

export const BOT_TABS = ["memory", "files", "browser", "details"] as const;
export const BotSearch = v.object({
  tab: optionalField(v.picklist(BOT_TABS)),
});

export const NewSessionSearch = v.object({
  workspace: optionalField(WorkspaceId),
});

export const SESSION_TABS = [
  "changes",
  "terminal",
  "files",
  "browser",
] as const;
export const SESSION_DEFAULTS = { view: "split" } as const;
export const SessionSearch = v.object({
  view: v.optional(v.fallback(v.picklist(["split", "full"]), "split"), "split"),
  tab: optionalField(v.picklist(SESSION_TABS)),
  agent: optionalField(v.string()),
});

export const RoutineSearch = v.object({
  run: optionalField(SessionId),
});

export const ARTIFACT_TYPES = [
  "document",
  "deck",
  "image",
  "code",
  "other",
] as const;
export const ARTIFACT_SOURCES = ["bots", "sessions"] as const;
export const ArtifactsSearch = v.object({
  type: optionalField(v.picklist(ARTIFACT_TYPES)),
  from: optionalField(v.picklist(ARTIFACT_SOURCES)),
  q: optionalField(v.pipe(v.string(), v.maxLength(200))),
  item: optionalField(v.string()),
});

export const ConnectorsSearch = v.object({
  connector: optionalField(v.string()),
});

/** The side-panel tabs each area offers (title-bar tabs, ⌘⌥B). */
export const AREA_PANEL_TABS = {
  bots: ["memory", "files", "browser", "details"],
  sessions: ["changes", "terminal", "files", "browser"],
  routines: ["details"],
  artifacts: ["details"],
  library: ["details"],
  settings: [],
} as const satisfies Record<string, readonly SidePanelTabId[]>;
