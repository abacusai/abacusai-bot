/**
 * The DB tables' wire contract (spec 00 B.1). Every table has `snapshot` and
 * `changes`; mutations exist only where the table can be written. The feeds
 * behind them are sub-slice B: until it lands main answers `UNAVAILABLE`.
 */
import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import { THEME_COLOR_KEYS } from "../look";
import { base, mutation, query, subscription } from "./base";
import { AvatarAccessorySchema, BotWallpaperSchema } from "./bots";
import {
  AgentModeSchema,
  BotId,
  RoutineId,
  SessionId,
  WorkspaceId,
} from "./ids";
import { SUPPORTED_LANGUAGES } from "./rows";
import type {
  ArtifactRow,
  BotRow,
  ChangeBatch,
  GitStateRow,
  MemoryRow,
  PrefsRow,
  PrefsThemeColors,
  RoutineRow,
  RoutineRunRow,
  SessionRow,
  TablePosition,
  TableSnapshot,
  WorkspaceRow,
} from "./rows";

const readTable = <Row, Key extends string = string>() => ({
  snapshot: query
    .input(v.optional(v.object({})))
    .output(type<TableSnapshot<Row>>()),
  /** Never ends by itself; `hello` first, then contiguous batches. */
  changes: subscription
    .input(v.optional(v.object({})))
    .output(eventIterator(type<ChangeBatch<Row, Key>>())),
});

const write = <TInput extends v.GenericSchema>(input: TInput) =>
  mutation.input(input).output(type<TablePosition>());

export const BotCreateInputSchema = v.object({
  sponsoredFirstRun: v.optional(v.boolean()),
  name: v.pipe(v.string(), v.nonEmpty()),
  title: v.optional(v.string()),
  description: v.string(),
  persona: v.optional(v.string()),
  avatarColor: v.optional(v.string()),
  avatarShape: v.optional(v.string()),
  avatarAccessory: AvatarAccessorySchema,
  wallpaper: BotWallpaperSchema,
  workspaceId: v.optional(v.nullable(v.string())),
  model: v.optional(v.nullable(v.string())),
  channel: v.optional(v.nullable(v.string())),
});

export const BotUpdateInputSchema = v.object({
  name: v.optional(v.string()),
  title: v.optional(v.string()),
  description: v.optional(v.string()),
  persona: v.optional(v.string()),
  avatarColor: v.optional(v.string()),
  avatarShape: v.optional(v.string()),
  avatarAccessory: AvatarAccessorySchema,
  wallpaper: BotWallpaperSchema,
  model: v.optional(v.nullable(v.string())),
  channel: v.optional(v.nullable(v.string())),
});

export const RoutineCreateInputSchema = v.object({
  name: v.optional(v.string()),
  schedule: v.optional(v.nullable(v.string())),
  runAt: v.optional(v.nullable(v.number())),
  webhook: v.optional(v.boolean()),
  prompt: v.string(),
  workspaceId: v.optional(v.nullable(v.string())),
  botId: v.optional(v.nullable(v.string())),
});

export const RoutineUpdateInputSchema = v.object({
  schedule: v.optional(v.nullable(v.string())),
  runAt: v.optional(v.nullable(v.number())),
  prompt: v.optional(v.string()),
  enabled: v.optional(v.boolean()),
  name: v.optional(v.string()),
  botId: v.optional(v.nullable(v.string())),
  workspaceId: v.optional(v.nullable(v.string())),
  webhook: v.optional(v.boolean()),
});

const NullableTimestamp = v.nullable(v.number());

export const BOT_SOUND_LEVELS = ["all", "needs-me", "nothing"] as const;
export const PREFS_TEXT_SIZES = [13, 14, 15] as const;
/** `@abacus-ai/connectors`' `MessagingPlatform` (checked in contract.types.test). */
export const PREFS_MESSAGING_PLATFORMS = [
  "whatsapp",
  "telegram",
  "discord",
] as const;

const HexColor = v.pipe(v.string(), v.regex(/^#[\da-f]{6}$/i));
const FontFamily = v.pipe(v.string(), v.regex(/^[\p{L}\p{N} ._-]{0,64}$/u));
/**
 * One theme variant: `bg` required, every other key one the engine knows
 * (seeds and overridable tokens), each a `#rrggbb`. Unknown keys are refused.
 */
const ThemeVariant = v.strictObject(
  Object.fromEntries(
    THEME_COLOR_KEYS.map((key) => [
      key,
      key === "bg" ? HexColor : v.optional(HexColor),
    ])
  ) as Record<string, typeof HexColor>
) as unknown as v.GenericSchema<PrefsThemeColors>;

/** Local wall-clock `HH:MM`, 24-hour. */
const ClockTime = v.pipe(v.string(), v.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/));

const OnboardingExitSchema = v.variant("to", [
  v.strictObject({
    to: v.literal("bot"),
    botId: v.pipe(v.string(), v.nonEmpty()),
    edit: v.optional(v.literal(true)),
  }),
  v.strictObject({ to: v.literal("new-session") }),
  v.strictObject({ to: v.literal("new-bot") }),
  v.strictObject({
    to: v.literal("bot-tour"),
    botId: v.pipe(v.string(), v.nonEmpty()),
  }),
]);

/**
 * Each prefs group's leaves (spec 00 B.2, C.4). Provenance is kept per leaf,
 * so a patch may carry any subset of a group's leaves.
 */
export const PREFS_GROUP_ENTRIES = {
  sidebar: {
    pinned: v.boolean(),
    openSection: v.nullable(v.picklist(["bots", "routines", "sessions"])),
  },
  pinned: { sessionIds: v.array(v.string()), botIds: v.array(v.string()) },
  models: {
    selectedModelId: v.nullable(v.string()),
    favoriteModelIds: v.array(v.string()),
    perWorkspace: v.record(v.string(), v.nullable(v.string())),
  },
  dismissals: {
    referralCardUntil: NullableTimestamp,
    upsell: v.boolean(),
    /** The browser's "Connect your WhatsApp" intro, seen (linked or skipped). */
    whatsappIntroAt: NullableTimestamp,
  },
  motion: { reduce: v.picklist(["system", "on", "off"]) },
  sounds: {
    enabled: v.boolean(),
    perEvent: v.record(v.string(), v.boolean()),
    perBot: v.record(v.string(), v.picklist(BOT_SOUND_LEVELS)),
    quietHours: v.strictObject({
      enabled: v.boolean(),
      start: ClockTime,
      end: ClockTime,
    }),
  },
  appearance: {
    textSize: v.picklist(PREFS_TEXT_SIZES),
    bubbleTint: v.boolean(),
    palette: v.pipe(v.string(), v.regex(/^[a-z][\da-z-]{0,47}$/)),
    accent: v.nullable(HexColor),
    contrast: v.picklist(["system", "standard", "high"]),
    radius: v.picklist(["sharp", "default", "round"]),
    uiFont: FontFamily,
    codeFont: FontFamily,
    codeFontSize: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(10),
      v.maxValue(18)
    ),
    translucency: v.boolean(),
    railIconsOnly: v.boolean(),
    custom: v.nullable(
      v.pipe(
        v.strictObject({
          name: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(48)),
          light: v.optional(ThemeVariant),
          dark: v.optional(ThemeVariant),
        }),
        v.check(
          (theme) => theme.light != null || theme.dark != null,
          "a theme needs a light or a dark variant"
        )
      )
    ),
  },
  notch: {
    enabled: v.boolean(),
    haptics: v.boolean(),
    idleVisible: v.boolean(),
    extraDisplays: v.boolean(),
    showInNotch: v.boolean(),
  },
  tour: {
    status: v.picklist(["unseen", "done", "skipped"]),
    at: NullableTimestamp,
  },
} as const;

/** The scalar (non-group) prefs fields, each one leaf. */
export const PREFS_SCALAR_ENTRIES = {
  theme: v.picklist(["system", "light", "dark"]),
  language: v.picklist(["system", ...SUPPORTED_LANGUAGES]),
  defaultMode: AgentModeSchema,
  workspaceExpanded: v.record(v.string(), v.boolean()),
  lastPickedWorkspaceId: v.nullable(v.string()),
  recentFolders: v.pipe(v.array(v.string()), v.maxLength(5)),
  creditsExhaustedAt: NullableTimestamp,
  browserHomepage: v.nullable(v.string()),
  onboardingStep: v.nullable(v.string()),
  panes: v.record(v.string(), v.number()),
  keymap: v.record(v.string(), v.nullable(v.string())),
  onboardingFlow: v.nullable(v.pipe(v.number(), v.integer())),
  onboardingExit: v.nullable(OnboardingExitSchema),
  onboardingPairing: v.pipe(
    v.array(v.picklist(PREFS_MESSAGING_PLATFORMS)),
    v.check(
      (platforms) => new Set(platforms).size === platforms.length,
      "duplicate platform"
    )
  ),
} as const;

const prefsGroup = <E extends v.ObjectEntries>(entries: E) =>
  v.optional(v.partial(v.strictObject(entries)));

const G = PREFS_GROUP_ENTRIES;
const S = PREFS_SCALAR_ENTRIES;

/**
 * Every field optional, unknown keys refused (B.2 `prefs`); a group takes
 * any subset of its leaves.
 */
export const PrefsPatchSchema = v.strictObject({
  theme: v.optional(S.theme),
  language: v.optional(S.language),
  sidebar: prefsGroup(G.sidebar),
  pinned: prefsGroup(G.pinned),
  models: prefsGroup(G.models),
  defaultMode: v.optional(S.defaultMode),
  workspaceExpanded: v.optional(S.workspaceExpanded),
  lastPickedWorkspaceId: v.optional(S.lastPickedWorkspaceId),
  recentFolders: v.optional(S.recentFolders),
  creditsExhaustedAt: v.optional(S.creditsExhaustedAt),
  browserHomepage: v.optional(S.browserHomepage),
  onboardingStep: v.optional(S.onboardingStep),
  dismissals: prefsGroup(G.dismissals),
  panes: v.optional(S.panes),
  motion: prefsGroup(G.motion),
  sounds: prefsGroup(G.sounds),
  keymap: v.optional(S.keymap),
  appearance: prefsGroup(G.appearance),
  notch: prefsGroup(G.notch),
  tour: prefsGroup(G.tour),
  onboardingFlow: v.optional(S.onboardingFlow),
  onboardingExit: v.optional(S.onboardingExit),
  onboardingPairing: v.optional(S.onboardingPairing),
});

export const MemoryDeleteInputSchema = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  scope: v.picklist(["global", "bot"]),
  target: v.nullable(v.picklist(["memory", "user", "remember"])),
  botId: v.nullable(BotId),
  /** The row the user clicked, so a stale click cannot delete its successor. */
  index: v.pipe(v.number(), v.integer(), v.minValue(0)),
  entry: v.string(),
  /** The row's `occurrences`: with duplicates, what tells a stale click. */
  occurrences: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

export const db = {
  sessions: {
    ...readTable<SessionRow>(),
    /**
     * A valid, unused client id is honoured; a taken one is `CONFLICT`.
     * `model` and `mode` are persisted at creation (spec 04 §26.4 d): the
     * agent's first start (`agent.start` without overrides, the relay's
     * start-on-send) runs on them.
     */
    insert: write(
      v.object({
        id: v.optional(SessionId),
        workspaceId: WorkspaceId,
        model: v.optional(v.nullable(v.pipe(v.string(), v.nonEmpty()))),
        mode: v.optional(v.nullable(AgentModeSchema)),
      })
    ),
    /** Only `label` and `model` are writable; any other field is `FORBIDDEN`. */
    update: write(
      v.object({
        id: SessionId,
        patch: v.looseObject({
          label: v.optional(v.string()),
          model: v.optional(v.string()),
        }),
      })
    ),
    delete: write(v.object({ id: SessionId })),
  },
  bots: {
    ...readTable<BotRow>(),
    insert: write(
      v.object({ ...BotCreateInputSchema.entries, id: v.optional(BotId) })
    ),
    update: write(v.object({ id: BotId, patch: BotUpdateInputSchema })),
    delete: write(v.object({ id: BotId })),
  },
  routines: {
    ...readTable<RoutineRow>(),
    insert: write(
      v.object({
        ...RoutineCreateInputSchema.entries,
        id: v.optional(RoutineId),
      })
    ),
    update: write(v.object({ id: RoutineId, patch: RoutineUpdateInputSchema })),
    delete: write(v.object({ id: RoutineId })),
  },
  /** Derived from `sessions`; read-only. Keyed by `sessionId`. */
  routineRuns: readTable<RoutineRunRow>(),
  /** Read-only; removed with their session. */
  artifacts: readTable<ArtifactRow>(),
  /** No insert: entries come from the agent (`remember`). */
  memories: {
    ...readTable<MemoryRow>(),
    delete: write(MemoryDeleteInputSchema),
  },
  /** No insert: `workspaces.add` derives the id from the path. */
  workspaces: {
    ...readTable<WorkspaceRow>(),
    update: write(
      v.object({ id: WorkspaceId, patch: v.object({ label: v.string() }) })
    ),
    delete: write(v.object({ id: WorkspaceId })),
  },
  /** The active workspace only, for now; read-only (`git.*` echoes here). */
  gitState: readTable<GitStateRow>(),
  /** One row, `"app"`, created with defaults on first read. */
  prefs: {
    ...readTable<PrefsRow, "app">(),
    update: base
      .meta({ kind: "mutation" })
      .input(v.object({ patch: PrefsPatchSchema }))
      .output(type<TablePosition<"app">>()),
  },
};
