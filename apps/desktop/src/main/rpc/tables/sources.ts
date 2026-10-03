/**
 * What the DB tables read and hook (spec 00 B.2). `ServiceHost` provides all
 * of it; tests pass fakes. Every `on*` returns its removal.
 */
import type { Bot } from "#shared/bots";
import type { GitStateRow } from "#shared/contract/rows";
import type {
  AgentSessionListItem,
  BotMemoryView,
  GitStateSnapshot,
  MemorySnapshot,
  SessionArtifact,
  SessionTurnStateSnapshot,
  WorkspaceMetadataSnapshot,
} from "#shared/contracts";
import type { Routine, RoutineListItem } from "#shared/routines";

export type Unhook = () => void;

export interface TableSources {
  listAllAgentSessions(): AgentSessionListItem[];
  listSessionTurnStates(): SessionTurnStateSnapshot[];
  /** Fired on every session record change, evented or not. */
  onSessionsChanged(listener: () => void): Unhook;
  listBots(): Bot[];
  /** Fired after every write of `bots.json`. */
  onBotsWritten(listener: () => void): Unhook;
  listRoutines(): RoutineListItem[];
  listRoutineHistories?(): Array<Pick<Routine, "id" | "runs">>;
  /** Fired after every write of `cronjobs.json`. */
  onRoutinesWritten(listener: () => void): Unhook;
  listSessionArtifacts(): SessionArtifact[];
  listMemories(): MemorySnapshot;
  listBotMemories(): BotMemoryView[];
  getMetadata(): WorkspaceMetadataSnapshot;
  /** Fired after every workspace store write. */
  onWorkspacesChanged(listener: () => void): Unhook;
  getGitState(): GitStateSnapshot;
  /**
   * The local workspace path `getGitState` describes (null: none, remote or
   * pathless). It lags the active workspace while a refresh is in flight.
   */
  gitStateWorkspacePath(): string | null;
  /**
   * While held, the active workspace's changes carry fingerprints (spec 04
   * §26.4 b). Optional: fakes without it publish none.
   */
  wantGitFingerprints?(): Unhook;
  /** The rows of checkouts with a live `git.watch` (spec 04 §26.4 b). */
  checkoutRows?(): GitStateRow[];
  onCheckoutRowsChanged?(listener: () => void): Unhook;
  /** `~/.abacusai-bot` (or `ABACUSAI_BOT_HOME`): the memory watchers' root. */
  botHome(): string;
}
