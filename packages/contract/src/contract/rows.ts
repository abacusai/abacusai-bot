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

export type SessionRow = Omit<AgentSessionListItem, "worktreeOperationId"> & {
  turn: { phase: SessionTurnPhase; isBusy: boolean; updatedAt: string } | null;
  /**
   * The `operationId` of the `git.worktrees.materialize` that attached this
   * session's worktree (spec 04 §26.4 g), so a start page can reconcile
   * after a reload. Main always sets it (null when none); not writable.
   */
  worktreeOperationId?: string | null;
};

export type BotRow = Bot & {
  /** Create-only input; main replaces this with sponsoredUntil in its echo. */
  sponsoredFirstRun?: boolean;
};

/** `recentRuns`: at most 20, newest first. */
export type RoutineRow = Omit<RoutineListItem, "runs"> & {
  recentRuns: RoutineRun[];
};

/**
 * A run session. `attemptId`: the `started`/`start-failed` history entry
 * with this session (null: none recorded). `result`: the latest follow-up's
 * result for that attempt (a timeout), else the attempt's own (spec 05
 * §31.5 f).
 */
export type RoutineRunRow = RoutineRunItem & {
  routineId: string;
  attemptId: string | null;
  result: string | null;
};

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
  /**
   * Copies of `entry` in the same list. A delete sends it back, so a stale
   * click on one of two identical entries is `CONFLICT`, not the other's
   * removal.
   */
  occurrences: number;
}

export type WorkspaceRow = WorkspaceListItem & { isActive: boolean };

/**
 * One checkout's git state (spec 04 §26.4 b), keyed by `checkoutKey`
 * (`shared/contract/checkout.ts`): the active workspace's primary checkout,
 * and every checkout with a live `git.watch`.
 */
export type GitStateRow = GitStateSnapshot & {
  workspaceId: string;
  checkoutKey: string;
  /** The directory the state was computed in (null: none, remote). */
  checkoutPath: string | null;
};

/**
 * The locales the app ships (renderer/locales/*.json; a shared test keeps the
 * two in step), in the order the old renderer's i18n lists them.
 */
export const SUPPORTED_LANGUAGES = [
  "en-US",
  "de-DE",
  "es-ES",
  "es-419",
  "fr-FR",
  "hi-IN",
  "id-ID",
  "it-IT",
  "ja-JP",
  "ko-KR",
  "pt-BR",
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export interface PrefsRow {
  id: "app";
  theme: "system" | "light" | "dark";
  /**
   * `"system"` (the default) follows the OS through `navigator.languages`;
   * an explicit code is the user's pick and stays, whatever the OS says
   * (spec 01 §9.2, §15.4).
   */
  language: "system" | SupportedLanguage;
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
  dismissals: {
    referralCardUntil: number | null;
    upsell: boolean;
    whatsappIntroAt: number | null;
  };
  /** Panel widths. */
  panes: Record<string, number>;
  motion: { reduce: "system" | "on" | "off" };
  sounds: {
    enabled: boolean;
    perEvent: Record<string, boolean>;
    /** Per-bot level (spec 05 §31.5 a); a bot not listed is `"all"`. */
    perBot?: Record<string, BotSoundLevel>;
    /** Local wall-clock `HH:MM`; `start > end` spans midnight. */
    quietHours?: QuietHours;
  };
  // ── Added by specs 05 (§31.5 a) and 06 (§23.5 b). Main's rows always carry
  // them (its defaults fill every leaf); they are optional in the type only
  // until renderer's `DEFAULT_PREFS` literal lists them (phase 5/6 own
  // that file).
  /** Binding id (`<action>` or `<action>@terminal`) → chord, null = unbound. */
  keymap?: Record<string, string | null>;
  appearance?: PrefsAppearance;
  notch?: {
    enabled: boolean;
    haptics: boolean;
    idleVisible: boolean;
    extraDisplays: boolean;
    showInNotch: boolean;
  };
  tour?: { status: "unseen" | "done" | "skipped"; at: number | null };
  /**
   * `2`: `onboardingStep` is in the new renderer's vocabulary (spec 06 F10);
   * anything else resumes at `welcome`.
   */
  onboardingFlow?: number | null;
  onboardingExit?: OnboardingExit | null;
  /** Platforms whose pairing was deferred during onboarding, deduplicated. */
  onboardingPairing?: PrefsMessagingPlatform[];
  updatedAt: string;
}

export type BotSoundLevel = "all" | "needs-me" | "nothing";

export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
}

export type PrefsTextSize = 13 | 14 | 15;

/**
 * An imported theme's variant: `bg` and the other seeds or overridable
 * tokens of `@abacus-ai/contract/look`, each `#rrggbb`.
 */
export type PrefsThemeColors = { bg: string } & Record<string, string>;

/**
 * The look (Appearance settings). `palette` names a built-in theme or
 * `"custom"` (the imported `custom`); an unknown id renders the default.
 * Fonts are system family names, empty for the bundled default.
 */
export interface PrefsAppearance {
  textSize: PrefsTextSize;
  bubbleTint: boolean;
  palette: string;
  accent: string | null;
  contrast: "system" | "standard" | "high";
  radius: "sharp" | "default" | "round";
  uiFont: string;
  codeFont: string;
  codeFontSize: number;
  translucency: boolean;
  custom: {
    name: string;
    light?: PrefsThemeColors;
    dark?: PrefsThemeColors;
  } | null;
}

export type PrefsMessagingPlatform = "whatsapp" | "telegram" | "discord";

/** Where onboarding's completion lands (spec 06 §6.5). */
export type OnboardingExit =
  | { to: "bot"; botId: string; edit?: true }
  | { to: "new-session" }
  | { to: "new-bot" }
  | { to: "bot-tour"; botId: string };

export type PrefsField = Exclude<keyof PrefsRow, "id" | "updatedAt">;

/** The fields that group several leaves; provenance is kept per leaf. */
export type PrefsGroup =
  | "sidebar"
  | "pinned"
  | "models"
  | "dismissals"
  | "motion"
  | "sounds"
  | "appearance"
  | "notch"
  | "tour";

/**
 * One provenance-tracked value (spec 00 B.2, C.4): a scalar field
 * (`"theme"`), or one leaf of a group (`"sidebar.pinned"`). Records
 * (`workspaceExpanded`, `panes`, `models.perWorkspace`, `sounds.perEvent`)
 * are whole leaves.
 */
export type PrefsLeaf =
  | Exclude<PrefsField, PrefsGroup>
  | {
      [
        G in PrefsGroup
      ]: `${G}.${Extract<keyof NonNullable<PrefsRow[G]>, string>}`;
    }[PrefsGroup];

/** Every field optional; a group carries only the leaves it sets. */
export type PrefsPatch = {
  [F in PrefsField]?: F extends PrefsGroup
    ? Partial<NonNullable<PrefsRow[F]>>
    : PrefsRow[F];
};
