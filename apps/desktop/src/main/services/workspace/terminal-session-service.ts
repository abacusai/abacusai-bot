import path from "node:path";

import type {
  PromoteTerminalSessionScopeRequest,
  ResizeTerminalSessionRequest,
  StartTerminalSessionRequest,
  StartTerminalSessionResult,
  TerminalRuntimeRequest,
  TerminalSessionSnapshot,
  WriteTerminalInputRequest,
} from "#shared/contracts";
import {
  conversationKey,
  draftConversationRef,
  sessionConversationRef,
  type ConversationKey,
  type ConversationRef,
} from "#shared/conversation-scope";
import type { TerminalShellId } from "#shared/terminal-shells";

import { readTerminalShell } from "../config/settings";
import {
  ConversationTerminalRuntimeRegistry,
  type ConversationTerminalAttachment,
  type ConversationTerminalEvent,
  type TerminalPty,
} from "../conversation/conversation-terminal-runtime-registry";
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
    pipe?: boolean;
  }
) => TerminalPty;

let cachedSpawn: PtySpawn | null = null;
let cachedSpawnError: Error | null = null;

const importZigPty = async (): Promise<{ spawn: PtySpawn }> => {
  if (process.platform !== "win32") {
    return (await import("zigpty")) as unknown as { spawn: PtySpawn };
  }

  // The pnpm patch makes zigpty honor this flag before eagerly loading its
  // Windows .node binding. Keep it scoped to module initialization; zigpty
  // retains the selected PipePty backend after the import completes.
  const previous = process.env.ZIGPTY_DISABLE_NATIVE;
  process.env.ZIGPTY_DISABLE_NATIVE = "1";
  try {
    return (await import("zigpty")) as unknown as { spawn: PtySpawn };
  } finally {
    if (previous == null) delete process.env.ZIGPTY_DISABLE_NATIVE;
    else process.env.ZIGPTY_DISABLE_NATIVE = previous;
  }
};

const loadSpawn = async (): Promise<PtySpawn> => {
  if (cachedSpawn != null) return cachedSpawn;
  if (cachedSpawnError != null) throw cachedSpawnError;
  try {
    const mod = await importZigPty();
    cachedSpawn = mod.spawn;
    return cachedSpawn;
  } catch (error) {
    cachedSpawnError =
      error instanceof Error ? error : new Error(String(error));
    throw cachedSpawnError;
  }
};

/**
 * What a terminal driver does to output on its way out, done here because on
 * Windows there is no driver to do it.
 *
 * A tty translates a bare line feed into a carriage return and a line feed
 * (ONLCR), and ConPTY does the same. This app spawns through zigpty's pipe
 * backend on Windows instead (see the note at the spawn), so a program that
 * ends its lines with `\n` alone — every POSIX-minded tool, busybox's applets
 * among them — walked its output diagonally across the panel, each line
 * starting where the last one ended.
 *
 * Translating here rather than in the terminal means the scrollback main
 * replays is already right, and a `\r\n` that was already correct is left
 * alone rather than doubled.
 */
const carriageReturns = (pty: TerminalPty): TerminalPty => {
  let endedOnCarriageReturn = false;

  return {
    // Delegated one by one rather than spread: a PTY is a class instance, and
    // spreading one copies the fields and leaves every method on the
    // prototype behind. `onExit is not a function`, on Windows only, because
    // Windows is the only platform that wraps.
    onExit: (callback) => pty.onExit(callback),
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: (signal) => pty.kill(signal),
    onData: (callback) =>
      pty.onData((chunk) => {
        if (typeof chunk !== "string") {
          callback(chunk);
          return;
        }
        if (!chunk.includes("\n")) {
          endedOnCarriageReturn = chunk.endsWith("\r");
          callback(chunk);
          return;
        }
        // A chunk can split a CRLF; the CR from the last one still counts.
        const leadsWithLineFeed =
          endedOnCarriageReturn && chunk.startsWith("\n");
        const head = leadsWithLineFeed ? "\n" : "";
        const rest = leadsWithLineFeed ? chunk.slice(1) : chunk;
        endedOnCarriageReturn = chunk.endsWith("\r");
        callback(`${head}${rest.replace(/(?<!\r)\n/g, "\r\n")}`);
      }),
  };
};

const sanitizeEnv = (value: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );

/**
 * The shell a start request asks for: the one it names, else the stored
 * preference. An automatically opened terminal sends nothing and so reopens
 * whatever was last picked from the panel's `+` menu.
 */
const requestedShell = (shell: TerminalShellId | undefined): TerminalShellId =>
  shell ?? readTerminalShell();

type TerminalSessionServiceOptions = {
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
    ? { kind: "draft" as const, workspaceId: conversation.workspaceId }
    : {
        kind: "session" as const,
        workspaceId: conversation.workspaceId,
        sessionId: conversation.sessionId,
      };

const conversationFromEvent = (
  event: ConversationTerminalEvent
): ConversationRef =>
  event.scope.kind === "draft"
    ? draftConversationRef(event.scope.workspaceId)
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

export class TerminalSessionService {
  private readonly registry: ConversationTerminalRuntimeRegistry;

  constructor(private readonly options: TerminalSessionServiceOptions) {
    this.registry = new ConversationTerminalRuntimeRegistry({
      createPty: async ({ scope, cols, rows, shell: requested }) => {
        const workspacePath = options.resolveWorkspacePath(
          scope.workspaceId,
          scope.kind === "session" ? scope.sessionId : undefined
        );
        if (workspacePath == null) {
          throw new Error("Workspace path is unavailable.");
        }
        const shell = resolveTerminalShell(requestedShell(requested));
        const spawn = await loadSpawn();
        const usesPipe = process.platform === "win32";
        const pty = spawn(shell.file, shell.args, {
          cwd: workspacePath,
          env: { ...sanitizeEnv(process.env), ...shell.env },
          cols,
          rows,
          encoding: "utf8",
          name: "xterm-256color",
          // zigpty's native Windows prebuild imports node.exe directly and can
          // execute invalid memory inside Electron. Its supported pipe backend
          // keeps the same API without loading ConPTY into the GUI process.
          pipe: usesPipe,
        });

        if (!usesPipe) return pty;

        // The pipe backend emulates a terminal in JavaScript, and its default
        // is canonical mode with its own echo — so every keystroke appeared
        // twice, once from it and once from the shell, which does its own
        // echo and its own line editing. Raw mode hands all of that back to
        // the shell, the way a console does.
        const raw = pty as TerminalPty & { setRawMode?: () => void };
        raw.setRawMode?.();

        // A pipe has no terminal driver behind it to end lines properly.
        return carriageReturns(pty);
      },
      onOutput: (event) =>
        options.emitTerminalOutput({
          terminalId: event.terminalId,
          conversationKey: event.key,
          conversation: conversationFromEvent(event),
          generation: event.generation,
          data: event.data,
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
    this.registry.disposeAll();
  }

  /** True while any terminal PTY is alive — a restart would kill it. */
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
      return {
        success: false,
        error: `Terminal backend unavailable: ${error instanceof Error ? error.message : String(error)}`,
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
      {
        kind: "draft",
        workspaceId: request.draftConversation.workspaceId,
      },
      {
        kind: "session",
        workspaceId: request.sessionConversation.workspaceId,
        sessionId: request.sessionConversation.sessionId,
      }
    );
    if (promoted.attachment == null) return null;
    let attachment = promoted.attachment;
    const workspacePath = this.options.resolveWorkspacePath(
      request.sessionConversation.workspaceId
    );
    const sessionPath = this.options.resolveWorkspacePath(
      request.sessionConversation.workspaceId,
      request.sessionConversation.sessionId
    );
    if (
      workspacePath != null &&
      sessionPath != null &&
      path.resolve(workspacePath) !== path.resolve(sessionPath)
    ) {
      const promotedAttachments = this.registry.list(attachment.key);
      this.registry.disposeScope(attachment.key);
      const restarted = await Promise.all(
        promotedAttachments.map(({ terminalId, cols, rows, shell }) =>
          this.registry.start({
            terminalId,
            shell,
            scope: {
              kind: "session",
              workspaceId: request.sessionConversation.workspaceId,
              sessionId: request.sessionConversation.sessionId,
            },
            cols,
            rows,
          })
        )
      );
      attachment =
        restarted.find((item) => item.terminalId === attachment.terminalId) ??
        restarted[0]!;
    }
    const state = snapshot(attachment);
    this.options.emitTerminalState(state);
    return state;
  }
}
