import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

import { childProcessEnv } from "@abacus-ai/agent/child-env";
import type {
  PromoteTerminalSessionScopeRequest,
  ResizeTerminalSessionRequest,
  StartTerminalSessionRequest,
  StartTerminalSessionResult,
  TerminalRuntimeRequest,
  TerminalSessionSnapshot,
  WriteTerminalInputRequest,
} from "@abacus-ai/contract/contracts";
import {
  conversationKey,
  conversationRefFromKey,
  draftConversationRef,
  sessionConversationRef,
  type ConversationKey,
  type ConversationRef,
} from "@abacus-ai/contract/conversation-scope";
import type { TerminalShellId } from "@abacus-ai/contract/terminal-shells";

import { readTerminalShell } from "../config/settings";
import {
  ConversationTerminalRuntimeRegistry,
  type ConversationTerminalAttachment,
  type ConversationTerminalEvent,
  type ConversationTerminalOutputState,
  type TerminalRetireReason,
  type TerminalPty,
} from "../conversation/conversation-terminal-runtime-registry";
import {
  loadScrollback,
  restoredOutput,
  saveScrollback,
  scrollbackKey,
  type SavedScrollback,
} from "./terminal-scrollback";
import { resolveTerminalShell } from "./terminal-shells";

type PtySpawn = (
  file: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    cols?: number;
    rows?: number;
    encoding?: string | null;
    name?: string;
    /** Windows: ConPTY through the bundled conpty.dll rather than the OS copy. */
    useConptyDll?: boolean;
  }
) => TerminalPty;

/** A start's error for a chat folder that is gone, then its path. */
const FOLDER_MISSING = "folder-missing:";

/** Then its path: a folder this user may not open. */
const FOLDER_DENIED = "folder-denied:";

const canEnter = (folder: string): boolean => {
  try {
    accessSync(folder, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const isDirectory = (folder: string): boolean => {
  try {
    return statSync(folder).isDirectory();
  } catch {
    return false;
  }
};

let cachedSpawn: PtySpawn | null = null;
let cachedSpawnError: Error | null = null;

const loadSpawn = async (): Promise<PtySpawn> => {
  if (cachedSpawn != null) return cachedSpawn;
  if (cachedSpawnError != null) throw cachedSpawnError;
  try {
    const mod = (await import("@lydell/node-pty")) as unknown as {
      spawn: PtySpawn;
    };
    cachedSpawn = mod.spawn;
    return cachedSpawn;
  } catch (error) {
    cachedSpawnError =
      error instanceof Error ? error : new Error(String(error));
    throw cachedSpawnError;
  }
};

/**
 * The shell a start request asks for: the one it names, else the stored
 * preference. An automatically opened terminal sends nothing and so reopens
 * whatever was last picked from the panel's `+` menu.
 */
const requestedShell = (shell: TerminalShellId | undefined): TerminalShellId =>
  shell ?? readTerminalShell();

type TerminalSessionServiceOptions = {
  /** Where chat terminals' output is kept across a restart; none, not kept. */
  scrollbackFile?: string;
  resolveWorkspacePath: (
    workspaceId: string,
    sessionId?: string
  ) => string | null;
  emitTerminalOutput: (event: {
    terminalId: string;
    conversationKey: ConversationKey;
    conversation: ConversationRef;
    generation: number;
    data: string;
  }) => void;
  emitTerminalExit: (event: {
    terminalId: string;
    conversationKey: ConversationKey;
    conversation: ConversationRef;
    generation: number;
    exitCode: number | null;
    signal: number | null;
  }) => void;
  emitTerminalState: (state: TerminalSessionSnapshot) => void;
  /**
   * A generation closed or superseded without an exit of its own (see the
   * registry's `onRetire`). Not a legacy event: the old renderer never
   * listened for one; `terminal.output` readers end on it.
   */
  emitTerminalRetired?: (event: {
    terminalId: string;
    conversationKey: ConversationKey;
    generation: number;
    reason: TerminalRetireReason;
  }) => void;
};

const assertIdentity = (
  key: ConversationKey,
  conversation: ConversationRef
): void => {
  if (conversationKey(conversation) !== key) {
    throw new Error("Terminal conversation key does not match its reference.");
  }
};

const registryScope = (conversation: ConversationRef) =>
  conversation.kind === "draft"
    ? {
        kind: "draft" as const,
        workspaceId: conversation.workspaceId,
        ...(conversation.draftId ? { draftId: conversation.draftId } : {}),
      }
    : {
        kind: "session" as const,
        workspaceId: conversation.workspaceId,
        sessionId: conversation.sessionId,
      };

const conversationFromEvent = (
  event: ConversationTerminalEvent
): ConversationRef =>
  event.scope.kind === "draft"
    ? draftConversationRef(event.scope.workspaceId, event.scope.draftId)
    : sessionConversationRef(event.scope.workspaceId, event.scope.sessionId);

const snapshot = (
  attachment: ConversationTerminalAttachment
): TerminalSessionSnapshot => ({
  terminalId: attachment.terminalId,
  conversationKey: attachment.key,
  conversation: conversationFromEvent(attachment),
  generation: attachment.generation,
  workspaceId: attachment.scope.workspaceId,
  status: "running",
  visible: attachment.visible,
  cols: attachment.cols,
  rows: attachment.rows,
  shell: attachment.shell,
  exitCode: null,
  exitedAt: null,
});

/**
 * Whether the shell itself is in the foreground, at its prompt. Unix only:
 * Windows reports the shell's own name whatever runs in it.
 */
const programName = (value: string) => path.basename(value).replace(/^-/, "");
const atPrompt = (pty: TerminalPty, file: string | undefined): boolean => {
  if (process.platform === "win32" || file == null || pty.process == null)
    return false;
  return programName(pty.process) === programName(file);
};

/** What runs in the foreground instead of the shell; null at its prompt or unknown (Windows). */
const foregroundProgram = (
  pty: TerminalPty,
  file: string | undefined
): string | null => {
  if (process.platform === "win32" || file == null || pty.process == null)
    return null;
  const running = programName(pty.process);
  return running === programName(file) ? null : running;
};

/** One POSIX shell word (bash, zsh, sh, fish). */
const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

export class TerminalSessionService {
  private readonly registry: ConversationTerminalRuntimeRegistry;
  /** The file each PTY was spawned from, to tell its shell from a program. */
  private readonly shellFiles = new WeakMap<TerminalPty, string>();
  /** Saved at the last quit and not yet shown: each is shown once. */
  private readonly restored: Map<string, SavedScrollback>;

  constructor(private readonly options: TerminalSessionServiceOptions) {
    this.restored =
      options.scrollbackFile == null
        ? new Map()
        : loadScrollback(options.scrollbackFile);
    this.registry = new ConversationTerminalRuntimeRegistry({
      restoreScrollback: (key, terminalId) => {
        const id = scrollbackKey(key, terminalId);
        const saved = this.restored.get(id);
        if (saved == null) return undefined;
        this.restored.delete(id);
        return restoredOutput(saved.data);
      },
      createPty: async ({ scope, cols, rows, shell: requested }) => {
        const workspacePath = options.resolveWorkspacePath(
          scope.workspaceId,
          scope.kind === "session" ? scope.sessionId : undefined
        );
        if (workspacePath == null) {
          throw new Error("Workspace path is unavailable.");
        }
        // A folder moved or deleted under the chat: say so, rather than a
        // shell that dies at once with chdir(2) failed.
        if (!isDirectory(workspacePath))
          throw new Error(`${FOLDER_MISSING}${workspacePath}`);
        if (!canEnter(workspacePath))
          throw new Error(`${FOLDER_DENIED}${workspacePath}`);
        const shell = resolveTerminalShell(requestedShell(requested));
        const spawn = await loadSpawn();
        const pty = spawn(shell.file, shell.args, {
          cwd: workspacePath,
          env: childProcessEnv(process.env, shell.env),
          cols,
          rows,
          encoding: "utf8",
          name: "xterm-256color",
          // The bundled ConPTY rather than whatever the OS shipped, and not
          // optional: with it off, `kill` forks a console-list agent through
          // `process.execPath`, which under Electron starts a second copy of
          // the app.
          useConptyDll: process.platform === "win32",
        });
        this.shellFiles.set(pty, shell.file);
        return pty;
      },
      onOutput: (event) =>
        options.emitTerminalOutput({
          terminalId: event.terminalId,
          conversationKey: event.key,
          conversation: conversationFromEvent(event),
          generation: event.generation,
          data: event.data,
        }),
      onRetire: (event) =>
        options.emitTerminalRetired?.({
          terminalId: event.terminalId,
          conversationKey: event.key,
          generation: event.generation,
          reason: event.reason,
        }),
      onExit: (event) => {
        const conversation = conversationFromEvent(event);
        options.emitTerminalExit({
          terminalId: event.terminalId,
          conversationKey: event.key,
          conversation,
          generation: event.generation,
          exitCode: event.exitCode,
          signal: event.signal,
        });
        options.emitTerminalState({
          terminalId: event.terminalId,
          conversationKey: event.key,
          conversation,
          generation: event.generation,
          workspaceId: event.scope.workspaceId,
          status: "stopped",
          visible: false,
          cols: 0,
          rows: 0,
          exitCode: event.exitCode,
          exitedAt: new Date().toISOString(),
        });
      },
    });
  }

  dispose(): void {
    // A chat's terminals come back after a restart (a new chat's don't):
    // keep their output, and what was saved for ones not reopened this time.
    if (this.options.scrollbackFile != null)
      saveScrollback(this.options.scrollbackFile, [
        ...this.registry
          .scrollbacks()
          .filter(({ key }) => conversationRefFromKey(key)?.kind === "session"),
        ...this.restored.values(),
      ]);
    this.registry.disposeAll();
  }

  /** The program a terminal is running in place of its shell's prompt. */
  busyProgram(key: ConversationKey, terminalId: string): string | null {
    const pty = this.registry.ptyOf(key, terminalId);
    return pty == null
      ? null
      : foregroundProgram(pty, this.shellFiles.get(pty));
  }

  /** Every terminal running a program, for the quit question. */
  busyTerminals(): {
    key: ConversationKey;
    terminalId: string;
    program: string;
  }[] {
    return this.registry.listAll().flatMap(({ key, terminalId }) => {
      const program = this.busyProgram(key, terminalId);
      return program == null ? [] : [{ key, terminalId, program }];
    });
  }

  /** True while any terminal PTY is alive. A restart would kill it. */
  hasLiveSessions(): boolean {
    return this.registry.hasLiveRuntimes();
  }

  async startSession(
    request: StartTerminalSessionRequest
  ): Promise<StartTerminalSessionResult> {
    try {
      assertIdentity(request.conversationKey, request.conversation);
      const terminalId = request.terminalId ?? "terminal-1";
      let attachment =
        request.generation == null
          ? null
          : this.registry.attach(
              request.conversationKey,
              request.generation,
              terminalId
            );
      if (request.generation != null && attachment == null) {
        throw new Error("Terminal generation is stale.");
      }
      let created = false;
      if (attachment == null) {
        const started = await this.registry.start({
          terminalId,
          scope: registryScope(request.conversation),
          cols: request.cols,
          rows: request.rows,
          // Resolved here rather than at spawn time so the snapshot names the
          // shell the terminal really got, fallback included.
          shell: resolveTerminalShell(requestedShell(request.shell)).id,
        });
        attachment = started;
        created = started.created;
      } else {
        this.registry.resize(
          attachment.key,
          attachment.generation,
          request.cols,
          request.rows,
          terminalId
        );
        attachment = this.registry.attach(
          attachment.key,
          attachment.generation,
          terminalId
        );
      }
      if (attachment == null)
        throw new Error("Terminal attach was superseded.");
      const state = snapshot(attachment);
      this.options.emitTerminalState(state);
      return {
        success: true,
        created,
        initialOutput: attachment.scrollback,
        state,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error:
          message.startsWith(FOLDER_MISSING) ||
          message.startsWith(FOLDER_DENIED)
            ? message
            : `Terminal backend unavailable: ${message}`,
        created: false,
        initialOutput: "",
        state: {
          terminalId: request.terminalId ?? "terminal-1",
          conversationKey: request.conversationKey,
          conversation: request.conversation,
          generation: request.generation ?? 0,
          workspaceId: request.conversation.workspaceId,
          status: "stopped",
          visible: false,
          cols: request.cols,
          rows: request.rows,
          exitCode: null,
          exitedAt: null,
        },
      };
    }
  }

  writeInput(request: WriteTerminalInputRequest): boolean {
    return this.registry.write(
      request.conversationKey,
      request.generation,
      request.data,
      request.terminalId
    );
  }

  resizeSession(request: ResizeTerminalSessionRequest): boolean {
    return this.registry.resize(
      request.conversationKey,
      request.generation,
      request.cols,
      request.rows,
      request.terminalId
    );
  }

  /** Every running terminal's state, in one conversation or in all of them. */
  listStates(key?: ConversationKey): TerminalSessionSnapshot[] {
    return (
      key == null ? this.registry.listAll() : this.registry.list(key)
    ).map(snapshot);
  }

  /** Offset-addressed output for `terminal.output`; see the registry. */
  outputState(request: {
    conversationKey: ConversationKey;
    terminalId?: string;
    generation: number;
    fromOffset?: number;
  }): ConversationTerminalOutputState | null {
    return this.registry.outputState(
      request.conversationKey,
      request.generation,
      request.terminalId,
      request.fromOffset
    );
  }

  hideSession(request: TerminalRuntimeRequest): boolean {
    return request.close === true
      ? this.registry.close(
          request.conversationKey,
          request.generation,
          request.terminalId
        )
      : this.registry.hide(
          request.conversationKey,
          request.generation,
          request.terminalId
        );
  }

  async promoteDraftToSession(
    request: PromoteTerminalSessionScopeRequest
  ): Promise<TerminalSessionSnapshot | null> {
    assertIdentity(request.draftConversationKey, request.draftConversation);
    assertIdentity(request.sessionConversationKey, request.sessionConversation);
    const promoted = await this.registry.promoteDraftToSession(
      // Its draft id too: the renderer keys a new chat's terminals by it.
      {
        kind: "draft",
        workspaceId: request.draftConversation.workspaceId,
        ...(request.draftConversation.draftId
          ? { draftId: request.draftConversation.draftId }
          : {}),
      },
      {
        kind: "session",
        workspaceId: request.sessionConversation.workspaceId,
        sessionId: request.sessionConversation.sessionId,
      }
    );
    if (promoted.attachment == null) return null;
    const attachment = promoted.attachment;
    const workspacePath = this.options.resolveWorkspacePath(
      request.sessionConversation.workspaceId
    );
    const sessionPath = this.options.resolveWorkspacePath(
      request.sessionConversation.workspaceId,
      request.sessionConversation.sessionId
    );
    // The chat moved to its own folder (a new worktree). The shells keep
    // running; one sitting at its prompt follows the chat there, a busy one
    // (a dev server, an editor) is left as it is.
    if (
      promoted.status === "promoted" &&
      workspacePath != null &&
      sessionPath != null &&
      path.resolve(workspacePath) !== path.resolve(sessionPath)
    ) {
      for (const { terminalId } of this.registry.list(attachment.key)) {
        const pty = this.registry.ptyOf(attachment.key, terminalId);
        if (pty != null && atPrompt(pty, this.shellFiles.get(pty)))
          pty.write(`\x15 cd -- ${shellQuote(sessionPath)}\r`);
      }
    }
    const state = snapshot(attachment);
    this.options.emitTerminalState(state);
    return state;
  }
}
