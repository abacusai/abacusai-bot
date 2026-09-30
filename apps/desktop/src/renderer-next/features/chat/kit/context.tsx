/**
 * The thread view's context: the session, the runtime, the skin and the
 * route-provided pieces (spec 02 §2 `ChatViewProps`). Widgets the kit
 * dispatches (`createChatUI` binds them once at module scope) read what they
 * need here instead of through props.
 */
import { createContext, use, type ReactNode } from "react";

import type { AgentMode } from "#shared/agent-types";

import type { ChatRuntime } from "../runtime/runtime";
import type { ThreadSession } from "../runtime/session";

interface ModelGroupItem {
  id: string;
  label: string;
  description?: string;
}

export interface ModelGroup {
  id: string;
  label: string;
  items: ModelGroupItem[];
  /** "Connect OpenRouter", shown when the provider is not configured. */
  connect?: { label: string; onSelect(): void };
}

/**
 * The model chip's binding (03-bots §24.2 amendment: nullable). `null` is
 * "App default"; `label` is then the resolved default's name.
 */
export interface ModelChipBinding {
  value: string | null;
  label: string;
  onChange(id: string | null): void;
  groups: ModelGroup[];
  layoutId?: string;
}

export interface MentionSource {
  search(query: string): Promise<string[]>;
}

export interface ComposerConfig {
  mode: "full" | "mini";
  /** Host-owned dictation preview; recording is a later slice. */
  dictating?: boolean;
  readOnly?: { reason: ReactNode; action?: ReactNode };
  placeholder: string;
  /** Folder for pasted files; null disables paste-to-file. */
  attachmentsBase: string | null;
  showModeChip: boolean;
  model: ModelChipBinding | null;
  mentions?: MentionSource;
  /** 03-bots §24.2: sent as `forwardedProps.mode` on every admission. */
  fixedMode?: AgentMode;
  /** Sessions: `agent.setMode` for a live runtime (the route knows the workspace). */
  setMode?: (mode: AgentMode) => Promise<void>;
  /** A new session with no runtime yet: mode and model go with the first send. */
  preStart?: boolean;
  /** The `db.sessions` turn column says busy (§4.4). */
  turnBusy?: boolean;
  /** Called after the first send of an untitled session (§8.3). */
  onFirstSend?: (text: string) => void;
}

interface Activity {
  status: string | null;
  runningToolTitle: string | null;
  runningTools: number;
}

export interface ChatViewSlots {
  empty?: ReactNode;
  banner?: ReactNode;
  /** 03-bots §24.2: scrolls with the transcript, above the first message. */
  header?: ReactNode;
  composerContext?: ReactNode;
  /** The route's pieces after the last run's outcome (the Changes card, phase 4). */
  runTail?: ReactNode;
  typingCaption?: (activity: Activity) => ReactNode;
}

export interface ChatViewContextValue {
  threadId: string;
  skin: "bot" | "session";
  session: ThreadSession;
  runtime: ChatRuntime;
  composer: ComposerConfig;
  slots: ChatViewSlots;
  workspaceRoot: string | null;
  onOpenFile?: (absPath: string) => void;
  onOpenSubagent?: (subagentRunId: string) => void;
  /** This view is the focused thread (Mod+. stops only here). */
  focused: boolean;
  /** Bots: the canvas's "Also in the notch" note on approval cards (phase 6). */
  notchEnabled: boolean;
  /** Registry of tool parts rendering their own permission card (§6.2). */
  inline: InlineRegistry;
}

export interface InlineRegistry {
  register(key: string): () => void;
  has(key: string): boolean;
  subscribe(listener: () => void): () => void;
  /** The registered keys; a new set after every change (a snapshot). */
  keys(): ReadonlySet<string>;
}

export const createInlineRegistry = (): InlineRegistry => {
  const counts = new Map<string, number>();
  const listeners = new Set<() => void>();
  let snapshot: ReadonlySet<string> = new Set();
  const notify = () => {
    snapshot = new Set(counts.keys());
    for (const listener of listeners) listener();
  };
  return {
    register: (key) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      notify();
      return () => {
        const next = (counts.get(key) ?? 1) - 1;
        if (next <= 0) counts.delete(key);
        else counts.set(key, next);
        notify();
      };
    },
    has: (key) => counts.has(key),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    keys: () => snapshot,
  };
};

const ChatViewContext = createContext<ChatViewContextValue | null>(null);

export const ChatViewProvider = ChatViewContext.Provider;

/** The enclosing view, or null outside one (the notch's `PermissionList`). */
export const useOptionalChatView = (): ChatViewContextValue | null =>
  use(ChatViewContext);

export const useChatView = (): ChatViewContextValue => {
  const value = use(ChatViewContext);
  if (value == null)
    throw new Error("chat: a chat widget rendered outside ChatView");
  return value;
};

/** The sub-agent a nested tool row belongs to (§5.5). */
const SubagentScopeContext = createContext<string | undefined>(undefined);
export const SubagentScope = SubagentScopeContext.Provider;
export const useSubagentScope = (): string | undefined =>
  use(SubagentScopeContext);
