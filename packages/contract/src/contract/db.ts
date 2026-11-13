/**
 * The DB tables' wire contract (spec 00 B.1). Every table has `snapshot` and
 * `changes`; mutations exist only where the table can be written. The feeds
 * behind them are sub-slice B: until it lands main answers `UNAVAILABLE`.
 */
import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import { HOME_CHANNELS } from "../bots";
import { CREDIT_TASK_KINDS, CREDIT_THRESHOLDS } from "../credit-thresholds";
import { THEME_COLOR_KEYS } from "../look";
import {
  KEEP_KINDS,
  SUCCESS_PITCH_LEADS,
  SUCCESS_PITCH_MOMENTS,
  SUCCESS_PITCH_TRIGGERS,
} from "../success-pitch";
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

/** A hand-off summary is a few thousand words at most; this is far past that. */
export const CONTINUATION_SUMMARY_MAX_CHARS = 60_000;

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
  homeChannel: v.optional(v.nullable(v.picklist(HOME_CHANNELS))),
  templateId: v.optional(v.nullable(v.string())),
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
  delegatesFreely: v.optional(v.boolean()),
  channel: v.optional(v.nullable(v.string())),
});

export const RoutineCreateInputSchema = v.object({
  name: v.optional(v.string()),
  schedule: v.optional(v.nullable(v.string())),
  runAt: v.optional(v.nullable(v.number())),
  until: v.optional(v.nullable(v.string())),
  webhook: v.optional(v.boolean()),
  prompt: v.string(),
  workspaceId: v.optional(v.nullable(v.string())),
  botId: v.optional(v.nullable(v.string())),
  runner: v.optional(v.picklist(["local", "hosted"])),
  kind: v.optional(v.picklist(["reminder", "task", "watch", "event"])),
  timezone: v.optional(v.nullable(v.string())),
  notify: v.optional(v.picklist(["always", "relevant"])),
  delivery: v.optional(v.picklist(["default", "whatsapp", "email", "panel"])),
  sources: v.optional(v.array(v.string())),
  reads: v.optional(
    v.array(v.picklist(["gmail.search", "gmail.read", "calendar.read"]))
  ),
  watchUrl: v.optional(v.nullable(v.string())),
  reminderText: v.optional(v.nullable(v.string())),
  uptimeUrl: v.optional(v.nullable(v.pipe(v.string(), v.url()))),
  quietIsNormal: v.optional(v.boolean()),
});

export const RoutineUpdateInputSchema = v.object({
  schedule: v.optional(v.nullable(v.string())),
  runAt: v.optional(v.nullable(v.number())),
  until: v.optional(v.nullable(v.string())),
  prompt: v.optional(v.string()),
  enabled: v.optional(v.boolean()),
  name: v.optional(v.string()),
  botId: v.optional(v.nullable(v.string())),
  workspaceId: v.optional(v.nullable(v.string())),
  webhook: v.optional(v.boolean()),
  model: v.optional(v.nullable(v.string())),
});

const NullableTimestamp = v.nullable(v.number());

const CreditThresholdSchema = v.picklist(CREDIT_THRESHOLDS);
const CreditThresholdMarkSchema = v.strictObject({
  reached: CreditThresholdSchema,
  at: v.number(),
  used: v.number(),
  granted: v.number(),
  perTask: v.nullable(v.number()),
  kind: v.nullable(v.picklist(CREDIT_TASK_KINDS)),
  told: v.nullable(CreditThresholdSchema),
  plan: v.optional(v.picklist(["free", "paid"])),
});

const SuccessPitchMarkSchema = v.strictObject({
  offer: v.nullable(
    v.strictObject({
      id: v.string(),
      sessionId: v.string(),
      trigger: v.picklist(SUCCESS_PITCH_TRIGGERS),
      moment: v.picklist(SUCCESS_PITCH_MOMENTS),
      lead: v.nullable(v.picklist(SUCCESS_PITCH_LEADS)),
      at: v.number(),
      name: v.optional(v.nullable(v.string())),
      detail: v.optional(v.nullable(v.string())),
    })
  ),
  appTurns: v.number(),
  chatTurns: v.number(),
  chatToldAt: NullableTimestamp,
  bigTaskChats: v.optional(v.array(v.string())),
  keepOffered: v.optional(v.array(v.string())),
});

const PitchCardSchema = v.strictObject({
  shown: v.number(),
  lastShownAt: NullableTimestamp,
  notNow: v.number(),
  shownOffer: v.nullable(v.string()),
  answered: v.nullable(v.string()),
});

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
    /** The browser's WhatsApp chat intro, seen (linked or skipped). */
    whatsappIntroAt: NullableTimestamp,
    /** The RouteLLM notice on another provider's model: times shown, when last, switched to RouteLLM. */
    routeLlmNudges: v.pipe(v.number(), v.integer(), v.minValue(0)),
    routeLlmNudgeAt: NullableTimestamp,
    routeLlmSwitched: v.boolean(),
    /** The upgrade's new-look notice, dismissed. */
    newLookSeenAt: NullableTimestamp,
    /** The agent told the user, once, where routines run 24/7. */
    routinesAlwaysOnToldAt: NullableTimestamp,
    /** The Routines page's 24/7 card, dismissed. */
    routinesAlwaysOnCardAt: NullableTimestamp,
    /** The newest missed-runs notice shown (its `missed.at`). */
    routinesMissedSeenAt: NullableTimestamp,
    creditThresholdCards: v.record(
      v.string(),
      v.strictObject({
        shown: v.nullable(CreditThresholdSchema),
        answered: v.nullable(CreditThresholdSchema),
      })
    ),
    successPitchCards: v.record(v.string(), PitchCardSchema),
    /** Per account: the free "keep it running" card, on its own budget. */
    keepRunningCards: v.record(v.string(), PitchCardSchema),
    /** The offer to turn a long answer into a document, shown and answered. */
    deliverableOffer: v.nullable(
      v.strictObject({
        shownOffer: v.nullable(v.string()),
        shownThread: v.nullable(v.string()),
        shownTurn: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
        answered: v.nullable(v.string()),
        misses: v.pipe(v.number(), v.integer(), v.minValue(0)),
        dismissed: v.pipe(v.number(), v.integer(), v.minValue(0)),
      })
    ),
    /** The next step under a result, shown and answered. */
    nextStepOffer: v.nullable(
      v.strictObject({
        shownOffer: v.nullable(v.string()),
        shownThread: v.nullable(v.string()),
        shownTurn: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
        answered: v.nullable(v.string()),
        misses: v.pipe(v.number(), v.integer(), v.minValue(0)),
        dismissed: v.pipe(v.number(), v.integer(), v.minValue(0)),
      })
    ),
    /** The retry on a top model, shown and answered. */
    retryOffer: v.nullable(
      v.strictObject({
        shownOffer: v.nullable(v.string()),
        shownThread: v.nullable(v.string()),
        shownTurn: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
        answered: v.nullable(v.string()),
        misses: v.pipe(v.number(), v.integer(), v.minValue(0)),
        dismissed: v.pipe(v.number(), v.integer(), v.minValue(0)),
      })
    ),
    /** The rating line: asked, answered, closed, or turned off. */
    ratingPrompt: v.nullable(
      v.strictObject({
        shownOffer: v.nullable(v.string()),
        shownThread: v.nullable(v.string()),
        shownAt: NullableTimestamp,
        answered: v.nullable(v.string()),
        dismissStreak: v.pipe(v.number(), v.integer(), v.minValue(0)),
        dismissedAt: NullableTimestamp,
        qualified: v.array(v.string()),
        askedThreads: v.array(v.string()),
        off: v.boolean(),
      })
    ),
    /** The top-model hint above the composer, shown and answered (top-model-hint.ts). */
    topModelHint: v.nullable(
      v.strictObject({
        shown: v.pipe(v.number(), v.integer(), v.minValue(0)),
        threads: v.array(v.string()),
        shownThread: v.nullable(v.string()),
        shownTurn: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
        dismissed: v.pipe(v.number(), v.integer(), v.minValue(0)),
        dismissedAt: NullableTimestamp,
        switched: v.boolean(),
      })
    ),
    /** The latest credit wall in the user's own chat, asked again once on return (wall-reopen.tsx). */
    wallReopen: v.optional(
      v.nullable(
        v.strictObject({
          sessionId: v.string(),
          wallAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
          askedAt: NullableTimestamp,
        })
      )
    ),
    /** The latest result in the user's own chat, offered on return (resume-card.ts). */
    resumeCard: v.optional(
      v.nullable(
        v.strictObject({
          sessionId: v.string(),
          resultAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
          wroteAt: v.pipe(v.number(), v.integer(), v.minValue(0)),
          closedAt: NullableTimestamp,
        })
      )
    ),
    /** The account first read on the free plan here, so a paid read after it is an upgrade. */
    freePlanSeenAt: NullableTimestamp,
    /** An older build's after-upgrade card, seen: that upgrade counts as welcomed. */
    upgradeRoutinesSeenAt: NullableTimestamp,
    /** Pairs of routines flagged as copies that the user chose to keep. */
    routineDuplicatesKept: v.array(v.string()),
    /** The plan tier the last paid welcome was shown for; null since the last free read. */
    paidWelcomeTier: v.nullable(v.string()),
    /** Per session: the site turn whose deploy card was closed. */
    siteDeployCards: v.record(v.string(), v.string()),
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
    accent: v.nullable(v.union([v.literal("default"), HexColor])),
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
    allowTwoTabRows: v.optional(v.boolean(), false),
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
  freeLaneChosenAt: NullableTimestamp,
  routineCreditHold: v.nullable(
    v.object({
      at: v.number(),
      routineId: v.string(),
    })
  ),
  creditThresholds: v.record(v.string(), CreditThresholdMarkSchema),
  successPitch: v.record(v.string(), SuccessPitchMarkSchema),
  /** Per session: its latest finished turn that built a site, stamped by main. */
  siteReady: v.record(
    v.string(),
    v.strictObject({
      turnId: v.string(),
      siteDir: v.nullable(v.string()),
      at: v.number(),
      kind: v.optional(v.picklist(KEEP_KINDS)),
      name: v.optional(v.nullable(v.string())),
    })
  ),
  browserHomepage: v.nullable(v.string()),
  showLinkPreviews: v.boolean(),
  /** Off: no `gh` call, no PR chip, tab or review anywhere. */
  githubIntegration: v.boolean(),
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
  freeLaneChosenAt: v.optional(S.freeLaneChosenAt),
  routineCreditHold: v.optional(S.routineCreditHold),
  creditThresholds: v.optional(S.creditThresholds),
  successPitch: v.optional(S.successPitch),
  siteReady: v.optional(S.siteReady),
  browserHomepage: v.optional(S.browserHomepage),
  showLinkPreviews: v.optional(S.showLinkPreviews),
  githubIntegration: v.optional(S.githubIntegration),
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
        sponsoredFirstRun: v.optional(v.boolean()),
        /** The chat this one continues; its summary goes with the first message. */
        continuation: v.optional(
          v.object({
            sessionId: SessionId,
            summary: v.pipe(
              v.string(),
              v.nonEmpty(),
              v.maxLength(CONTINUATION_SUMMARY_MAX_CHARS)
            ),
          })
        ),
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
