/**
 * What the DB tables read and hook (spec 00 B.2). `ServiceHost` provides all
 * of it; tests pass fakes. Every `on*` returns its removal.
 */
import type { Bot } from "#shared/bots";
import type {
  AgentSessionListItem,
  BotMemoryView,
  GitStateSnapshot,
  MemorySnapshot,
  SessionArtifact,
  SessionTurnStateSnapshot,
  WorkspaceMetadataSnapshot,
} from "#shared/contracts";
import type { RoutineListItem } from "#shared/routines";

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
  /** `~/.abacusai-bot` (or `ABACUSAI_BOT_HOME`): the memory watchers' root. */
  botHome(): string;
}
