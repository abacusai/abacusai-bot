/**
 * Row types of the DB tables (spec 00 B.2), shared by main's feeds and the
 * renderer's collections, plus the wire protocol every table speaks (B.1).
 * Declared here in sub-slice A because the `db.*` contract names them; the
 * feeds that fill them are sub-slice B.
 */
import type { AgentMode } from "../agent-types";
import type { Bot } from "../bots";
import type {
  AgentSessionListItem,
  GitStateSnapshot,
  MemoryTargetId,
  RoutineRunItem,
  SessionArtifact,
  SessionTurnPhase,
  WorkspaceListItem,
} from "../contracts";
import type { RoutineListItem, RoutineRun } from "../routines";

/** Random per main-process start; seqs compare only within one epoch. */
export type Epoch = string;

export type Change<Row, Key> =
  | { type: "insert"; key: Key; value: Row }
  /** Always the full row (`rowUpdateMode: "full"`). */
  | { type: "update"; key: Key; value: Row }
  | { type: "delete"; key: Key };

export type ChangeBatch<Row, Key> =
  /** The first yield of every `changes()` stream. */
  | { kind: "hello"; epoch: Epoch; seq: number }
  /** `seq` is the previous batch's plus one. */
  | { kind: "changes"; epoch: Epoch; seq: number; changes: Change<Row, Key>[] }
  /** "Your copy is invalid; re-snapshot." */
  | { kind: "reset"; epoch: Epoch; seq: number };

export interface TableSnapshot<Row> {
  epoch: Epoch;
  seq: number;
  rows: Row[];
}

/** Where a mutation's echo landed: the batch that carries it. */
export interface TablePosition<Key = string> {
  epoch: Epoch;
  seq: number;
  key: Key;
}

export type SessionRow = AgentSessionListItem & {
  turn: { phase: SessionTurnPhase; isBusy: boolean; updatedAt: string } | null;
};

export type BotRow = Bot;

/** `recentRuns`: at most 20, newest first. */
export type RoutineRow = Omit<RoutineListItem, "runs"> & {
  recentRuns: RoutineRun[];
};

export type RoutineRunRow = RoutineRunItem & { routineId: string };

export type ArtifactRow = SessionArtifact;

export interface MemoryRow {
  /** `${scope}:${botId ?? target}:${sha256(entry).slice(0, 16)}:${n}` */
  id: string;
  scope: "global" | "bot";
  target: MemoryTargetId | null;
  botId: string | null;
  botName: string | null;
  index: number;
  entry: string;
}

export type WorkspaceRow = WorkspaceListItem & { isActive: boolean };

export type GitStateRow = GitStateSnapshot & { workspaceId: string };

export interface PrefsRow {
  id: "app";
  theme: "system" | "light" | "dark";
  /** BCP-47, default "en-US". */
  language: string;
  sidebar: {
    pinned: boolean;
    openSection: "bots" | "routines" | "sessions" | null;
  };
  pinned: { sessionIds: string[]; botIds: string[] };
  models: {
    selectedModelId: string | null;
    favoriteModelIds: string[];
    perWorkspace: Record<string, string | null>;
  };
  defaultMode: AgentMode;
  workspaceExpanded: Record<string, boolean>;
  lastPickedWorkspaceId: string | null;
  /** At most 5. */
  recentFolders: string[];
  creditsExhaustedAt: number | null;
  browserHomepage: string | null;
  onboardingStep: string | null;
  dismissals: { referralCardUntil: number | null; upsell: boolean };
  /** Panel widths. */
  panes: Record<string, number>;
  motion: { reduce: "system" | "on" | "off" };
  sounds: { enabled: boolean; perEvent: Record<string, boolean> };
  updatedAt: string;
}

export type PrefsField = Exclude<keyof PrefsRow, "id" | "updatedAt">;

export type PrefsPatch = Partial<Pick<PrefsRow, PrefsField>>;
