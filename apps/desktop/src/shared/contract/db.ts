/**
 * The DB tables' wire contract (spec 00 B.1). Every table has `snapshot` and
 * `changes`; mutations exist only where the table can be written. The feeds
 * behind them are sub-slice B: until it lands main answers `UNAVAILABLE`.
 */
import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import { base, mutation, query, subscription } from "./base";
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
  name: v.pipe(v.string(), v.nonEmpty()),
  title: v.optional(v.string()),
  description: v.string(),
  persona: v.optional(v.string()),
  avatarColor: v.optional(v.string()),
  avatarShape: v.optional(v.string()),
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

/** Every field optional, unknown keys refused (B.2 `prefs`). */
export const PrefsPatchSchema = v.strictObject({
  theme: v.optional(v.picklist(["system", "light", "dark"])),
  language: v.optional(v.picklist(["system", ...SUPPORTED_LANGUAGES])),
  sidebar: v.optional(
    v.object({
      pinned: v.boolean(),
      openSection: v.nullable(v.picklist(["bots", "routines", "sessions"])),
    })
  ),
  pinned: v.optional(
    v.object({ sessionIds: v.array(v.string()), botIds: v.array(v.string()) })
  ),
  models: v.optional(
    v.object({
      selectedModelId: v.nullable(v.string()),
      favoriteModelIds: v.array(v.string()),
      perWorkspace: v.record(v.string(), v.nullable(v.string())),
    })
  ),
  defaultMode: v.optional(AgentModeSchema),
  workspaceExpanded: v.optional(v.record(v.string(), v.boolean())),
  lastPickedWorkspaceId: v.optional(v.nullable(v.string())),
  recentFolders: v.optional(v.pipe(v.array(v.string()), v.maxLength(5))),
  creditsExhaustedAt: v.optional(NullableTimestamp),
  browserHomepage: v.optional(v.nullable(v.string())),
  onboardingStep: v.optional(v.nullable(v.string())),
  dismissals: v.optional(
    v.object({ referralCardUntil: NullableTimestamp, upsell: v.boolean() })
  ),
  panes: v.optional(v.record(v.string(), v.number())),
  motion: v.optional(v.object({ reduce: v.picklist(["system", "on", "off"]) })),
  sounds: v.optional(
    v.object({
      enabled: v.boolean(),
      perEvent: v.record(v.string(), v.boolean()),
    })
  ),
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
    /** A valid, unused client id is honoured; a taken one is `CONFLICT`. */
    insert: write(
      v.object({ id: v.optional(SessionId), workspaceId: WorkspaceId })
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

export const DB_TABLES = Object.keys(db) as (keyof typeof db)[];
