/**
 * Search schemas (spec 01 §6.2). Every field falls back instead of throwing,
 * so a bad or stale URL still opens; defaults are stripped from built links.
 * Ids reuse the contract's atoms so URLs and procedure inputs share one rule.
 */
import * as v from "valibot";

import { AbsPath, SessionId, WorkspaceId } from "#shared/contract/ids";

/** Optional; an invalid value falls back to absent instead of throwing. */
export const optionalField = <
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(
  schema: TSchema
) => v.fallback(v.optional(schema), undefined);

const SIDE_PANEL_TABS = [
  "changes",
  "terminal",
  "files",
  "browser",
  "memory",
  "details",
  "agent",
] as const;
const SidePanelTab = v.picklist(SIDE_PANEL_TABS);
export type SidePanelTabId = v.InferOutput<typeof SidePanelTab>;

export const SessionTabRef = v.union([
  v.picklist(["chat", "changes", "files", "agents", "device"]),
  v.pipe(
    v.string(),
    v.regex(/^(terminal|browser|preview):[A-Za-z0-9._-]{1,80}$/)
  ),
]);
export type SessionTabRef = v.InferOutput<typeof SessionTabRef>;

export const ShellSearch = v.object({
  /** The side panel is open on this tab; absent = closed. */
  tab: optionalField(v.union([SidePanelTab, SessionTabRef])),
});
export const SHELL_DEFAULTS = {} as const;

const BOT_TABS = ["memory", "files", "browser", "details"] as const;
export const BotSearch = v.object({
  tab: optionalField(v.picklist(BOT_TABS)),
  /** The Files tab's read-only preview (03-bots §5.2, §11.3a). */
  preview: optionalField(AbsPath),
});

export const NewSessionSearch = v.object({
  workspace: optionalField(WorkspaceId),
});

export const SESSION_DEFAULTS = { view: "split" } as const;
export const SessionSearch = v.object({
  view: v.optional(v.fallback(v.picklist(["split", "full"]), "split"), "split"),
  tab: optionalField(SessionTabRef),
  agent: optionalField(v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]{1,80}$/))),
  file: optionalField(v.pipe(v.string(), v.maxLength(4096))),
  scope: optionalField(v.picklist(["staged", "unstaged"])),
});
export const DiffSearch = v.object({
  ...SessionSearch.entries,
  path: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
  source: v.optional(v.fallback(v.picklist(["git", "tool"]), "git"), "git"),
  toolKey: optionalField(v.string()),
  mode: v.optional(
    v.fallback(v.picklist(["unified", "split"]), "unified"),
    "unified"
  ),
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
  // `browser` is accepted in the URL but has no bots surface until phase 4.
  bots: ["details", "memory", "files"],
  sessions: ["changes", "terminal", "files", "browser"],
  routines: ["details"],
  artifacts: ["details"],
  library: ["details"],
  settings: [],
} as const satisfies Record<string, readonly SidePanelTabId[]>;
