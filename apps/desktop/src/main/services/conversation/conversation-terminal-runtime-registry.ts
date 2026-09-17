import type { TerminalShellId } from "#shared/terminal-shells";

import {
  conversationBelongsToWorkspace,
  conversationKey,
  type ConversationKey,
  type ConversationScope,
  type DraftConversationScope,
  type SessionConversationScope,
} from "./conversation-key";

export type TerminalPty = {
  onData: (callback: (data: string | Buffer | Uint8Array) => void) => unknown;
  onExit: (
    callback: (event: { exitCode: number; signal?: number | null }) => void
  ) => unknown;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
};

export type CreateConversationTerminalPty = (request: {
  terminalId: string;
  scope: ConversationScope;
  key: ConversationKey;
  generation: number;
  cols: number;
  rows: number;
  /** Absent means the caller's own default; the registry only carries it. */
  shell?: TerminalShellId;
}) => TerminalPty | Promise<TerminalPty>;

export type ConversationTerminalEvent = {
  terminalId: string;
  key: ConversationKey;
  scope: ConversationScope;
  generation: number;
};

export type ConversationTerminalOutputEvent = ConversationTerminalEvent & {
  data: string;
};

export type ConversationTerminalExitEvent = ConversationTerminalEvent & {
  exitCode: number | null;
  signal: number | null;
};

export type ConversationTerminalAttachment = ConversationTerminalEvent & {
  cols: number;
  rows: number;
  visible: boolean;
  scrollback: string;
  /**
   * What this terminal was started with, so a reattach reports it and a
   * scope promotion restarts the same shell rather than the current default.
   */
  shell?: TerminalShellId;
};

export type StartConversationTerminalResult = ConversationTerminalAttachment & {
  created: boolean;
};

export type PromoteConversationTerminalResult = {
  status: "promoted" | "empty" | "already-promoted";
  attachment: ConversationTerminalAttachment | null;
};

export type ConversationTerminalRuntimeRegistryOptions = {
  createPty: CreateConversationTerminalPty;
  maxScrollbackBytes?: number;
  onOutput?: (event: ConversationTerminalOutputEvent) => void;
  onExit?: (event: ConversationTerminalExitEvent) => void;
};

type Runtime = {
  terminalId: string;
  key: ConversationKey;
  scope: ConversationScope;
  generation: number;
  pty: TerminalPty;
  shell?: TerminalShellId;
  cols: number;
  rows: number;
  visible: boolean;
  scrollback: BoundedScrollback;
};

type PendingStart = {
  terminalId: string;
  scope: ConversationScope;
  generation: number;
  promise: Promise<StartConversationTerminalResult>;
};

const DEFAULT_SCROLLBACK_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TERMINAL_ID = "terminal-1";

const runtimeKey = (key: ConversationKey, terminalId: string): string =>
  `${key}\u0000${terminalId}`;

const safeUtf8Suffix = (value: Buffer, maximumBytes: number): Buffer => {
  if (value.length <= maximumBytes) return value;
  let start = value.length - maximumBytes;
  while (start < value.length && (value[start]! & 0xc0) === 0x80) start += 1;
  return value.subarray(start);
};

export class BoundedScrollback {
  private chunks: Buffer[] = [];
  private byteLength = 0;

  constructor(readonly maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new Error("maximumBytes must be a positive safe integer.");
    }
  }

  append(value: string): void {
    let chunk = safeUtf8Suffix(Buffer.from(value, "utf8"), this.maximumBytes);
    if (chunk.length === 0) return;

    this.chunks.push(chunk);
    this.byteLength += chunk.length;
    let overflow = this.byteLength - this.maximumBytes;
    while (overflow > 0 && this.chunks.length > 0) {
      const first = this.chunks[0]!;
      if (first.length <= overflow) {
        this.chunks.shift();
        this.byteLength -= first.length;
        overflow -= first.length;
        continue;
      }
      chunk = safeUtf8Suffix(first, first.length - overflow);
      this.chunks[0] = chunk;
      this.byteLength -= first.length - chunk.length;
      overflow = 0;
    }
  }

  read(): string {
    return Buffer.concat(this.chunks, this.byteLength).toString("utf8");
  }
}

const decodeChunk = (data: string | Buffer | Uint8Array): string => {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
};

export class ConversationTerminalRuntimeRegistry {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly pendingStarts = new Map<string, PendingStart>();
  private readonly generations = new Map<string, number>();
  private readonly promotedSessionKeys = new Set<ConversationKey>();
  private readonly maximumScrollbackBytes: number;

  constructor(
    private readonly options: ConversationTerminalRuntimeRegistryOptions
  ) {
    this.maximumScrollbackBytes =
      options.maxScrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES;
    if (
      !Number.isSafeInteger(this.maximumScrollbackBytes) ||
      this.maximumScrollbackBytes < 1
    ) {
      throw new Error("maxScrollbackBytes must be a positive safe integer.");
    }
  }

  async start(request: {
    terminalId?: string;
    scope: ConversationScope;
    cols: number;
    rows: number;
    shell?: TerminalShellId;
  }): Promise<StartConversationTerminalResult> {
    const key = conversationKey(request.scope);
    const terminalId = request.terminalId ?? DEFAULT_TERMINAL_ID;
    const id = runtimeKey(key, terminalId);
    const established = this.runtimes.get(id);
    if (established != null) {
      established.cols = request.cols;
      established.rows = request.rows;
      established.visible = true;
      established.pty.resize(request.cols, request.rows);
      return { ...this.attachment(established), created: false };
    }

    const pending = this.pendingStarts.get(id);
    if (pending != null) return pending.promise;

    const generation = this.nextGeneration(id);
    const promise = this.createRuntime(request, key, terminalId, generation);
    this.pendingStarts.set(id, {
      terminalId,
      scope: request.scope,
      generation,
      promise,
    });
    try {
      return await promise;
    } finally {
      const current = this.pendingStarts.get(id);
      if (current?.promise === promise) this.pendingStarts.delete(id);
    }
  }

  attach(
    key: ConversationKey,
    expectedGeneration?: number,
    terminalId = DEFAULT_TERMINAL_ID
  ): ConversationTerminalAttachment | null {
    const runtime = this.currentRuntime(key, terminalId, expectedGeneration);
    if (runtime == null) return null;
    runtime.visible = true;
    return this.attachment(runtime);
  }

  /**
   * True while any PTY is running or being spawned. Exited terminals are
   * removed from the map by their own onExit, so this never sticks on a dead
   * shell — but a live one counts even sitting at a prompt, because from here
   * a quiet dev server and an idle shell look the same.
   */
  hasLiveRuntimes(): boolean {
    return this.runtimes.size > 0 || this.pendingStarts.size > 0;
  }

  list(key: ConversationKey): ConversationTerminalAttachment[] {
    return [...this.runtimes.values()]
      .filter((runtime) => runtime.key === key)
      .map((runtime) => this.attachment(runtime));
  }

  write(
    key: ConversationKey,
    generation: number,
    data: string,
    terminalId = DEFAULT_TERMINAL_ID
  ): boolean {
    const runtime = this.currentRuntime(key, terminalId, generation);
    if (runtime == null) return false;
    runtime.pty.write(data);
    return true;
  }

  resize(
    key: ConversationKey,
    generation: number,
    cols: number,
    rows: number,
    terminalId = DEFAULT_TERMINAL_ID
  ): boolean {
    const runtime = this.currentRuntime(key, terminalId, generation);
    if (runtime == null) return false;
    runtime.cols = cols;
    runtime.rows = rows;
    runtime.pty.resize(cols, rows);
    return true;
  }

  hide(
    key: ConversationKey,
    generation: number,
    terminalId = DEFAULT_TERMINAL_ID
  ): boolean {
    const runtime = this.currentRuntime(key, terminalId, generation);
    if (runtime == null) return false;
    runtime.visible = false;
    return true;
  }

  close(
    key: ConversationKey,
    expectedGeneration?: number,
    terminalId = DEFAULT_TERMINAL_ID
  ): boolean {
    const id = runtimeKey(key, terminalId);
    const runtime = this.currentRuntime(key, terminalId, expectedGeneration);
    const pending = this.pendingStarts.get(id);
    if (runtime == null && pending == null) return false;
    if (
      expectedGeneration != null &&
      runtime == null &&
      pending?.generation !== expectedGeneration
    ) {
      return false;
    }

    this.invalidate(id);
    if (runtime != null) {
      this.runtimes.delete(id);
      runtime.pty.kill();
    }
    return true;
  }

  async promoteDraftToSession(
    draft: DraftConversationScope,
    session: SessionConversationScope
  ): Promise<PromoteConversationTerminalResult> {
    if (draft.workspaceId !== session.workspaceId) {
      throw new Error("A terminal cannot move between workspaces.");
    }
    const draftKey = conversationKey(draft);
    const sessionKey = conversationKey(session);
    if (this.promotedSessionKeys.has(sessionKey)) {
      const target = [...this.runtimes.values()].find(
        (runtime) => runtime.key === sessionKey
      );
      return {
        status: "already-promoted",
        attachment: target == null ? null : this.attachment(target),
      };
    }

    const pending = [...this.pendingStarts.values()].filter(
      (entry) => conversationKey(entry.scope) === draftKey
    );
    await Promise.all(
      pending.map((entry) => entry.promise.catch(() => undefined))
    );

    const sources = [...this.runtimes.values()].filter(
      (runtime) => runtime.key === draftKey
    );
    const targets = [...this.runtimes.values()].filter(
      (runtime) => runtime.key === sessionKey
    );
    const targetIds = new Set(targets.map((runtime) => runtime.terminalId));
    if (sources.some((runtime) => targetIds.has(runtime.terminalId))) {
      throw new Error("The target session already owns that terminal tab.");
    }

    this.promotedSessionKeys.add(sessionKey);
    if (sources.length === 0) {
      return {
        status: targets.length === 0 ? "empty" : "already-promoted",
        attachment: targets[0] == null ? null : this.attachment(targets[0]),
      };
    }

    for (const source of sources) {
      const sourceId = runtimeKey(draftKey, source.terminalId);
      const targetId = runtimeKey(sessionKey, source.terminalId);
      this.runtimes.delete(sourceId);
      source.key = sessionKey;
      source.scope = session;
      source.generation = Math.max(
        (this.generations.get(targetId) ?? 0) + 1,
        source.generation + 1
      );
      this.generations.set(targetId, source.generation);
      this.runtimes.set(targetId, source);
    }
    return { status: "promoted", attachment: this.attachment(sources[0]!) };
  }

  disposeScope(key: ConversationKey): boolean {
    const terminalIds = new Set<string>();
    for (const runtime of this.runtimes.values()) {
      if (runtime.key === key) terminalIds.add(runtime.terminalId);
    }
    for (const pending of this.pendingStarts.values()) {
      if (conversationKey(pending.scope) === key)
        terminalIds.add(pending.terminalId);
    }
    for (const terminalId of terminalIds)
      this.close(key, undefined, terminalId);
    return terminalIds.size > 0;
  }

  disposeWorkspace(workspaceId: string): number {
    const entries = new Map<
      string,
      { key: ConversationKey; terminalId: string }
    >();
    for (const runtime of this.runtimes.values()) {
      if (runtime.scope.workspaceId === workspaceId) {
        entries.set(runtimeKey(runtime.key, runtime.terminalId), runtime);
      }
    }
    for (const pending of this.pendingStarts.values()) {
      if (pending.scope.workspaceId === workspaceId) {
        const key = conversationKey(pending.scope);
        entries.set(runtimeKey(key, pending.terminalId), {
          key,
          terminalId: pending.terminalId,
        });
      }
    }
    for (const { key, terminalId } of entries.values()) {
      this.close(key, undefined, terminalId);
    }
    for (const key of this.promotedSessionKeys) {
      if (conversationBelongsToWorkspace(key, workspaceId)) {
        this.promotedSessionKeys.delete(key);
      }
    }
    return entries.size;
  }

  disposeAll(): number {
    const entries = new Map<
      string,
      { key: ConversationKey; terminalId: string }
    >();
    for (const runtime of this.runtimes.values()) {
      entries.set(runtimeKey(runtime.key, runtime.terminalId), runtime);
    }
    for (const pending of this.pendingStarts.values()) {
      const key = conversationKey(pending.scope);
      entries.set(runtimeKey(key, pending.terminalId), {
        key,
        terminalId: pending.terminalId,
      });
    }
    for (const { key, terminalId } of entries.values()) {
      this.close(key, undefined, terminalId);
    }
    this.promotedSessionKeys.clear();
    return entries.size;
  }

  private async createRuntime(
    request: {
      terminalId?: string;
      scope: ConversationScope;
      cols: number;
      rows: number;
      shell?: TerminalShellId;
    },
    key: ConversationKey,
    terminalId: string,
    generation: number
  ): Promise<StartConversationTerminalResult> {
    const id = runtimeKey(key, terminalId);
    const pty = await this.options.createPty({
      terminalId,
      scope: request.scope,
      key,
      generation,
      cols: request.cols,
      rows: request.rows,
      shell: request.shell,
    });
    if (this.generations.get(id) !== generation) {
      pty.kill();
      throw new Error("Terminal start was superseded.");
    }

    const runtime: Runtime = {
      terminalId,
      key,
      scope: request.scope,
      generation,
      pty,
      shell: request.shell,
      cols: request.cols,
      rows: request.rows,
      visible: true,
      scrollback: new BoundedScrollback(this.maximumScrollbackBytes),
    };
    this.runtimes.set(id, runtime);

    pty.onData((rawData) => {
      if (!this.isCurrent(runtime)) return;
      const data = decodeChunk(rawData);
      runtime.scrollback.append(data);
      this.options.onOutput?.({
        terminalId: runtime.terminalId,
        key: runtime.key,
        scope: runtime.scope,
        generation: runtime.generation,
        data,
      });
    });
    pty.onExit((event) => {
      if (!this.isCurrent(runtime)) return;
      this.runtimes.delete(runtimeKey(runtime.key, runtime.terminalId));
      this.options.onExit?.({
        terminalId: runtime.terminalId,
        key: runtime.key,
        scope: runtime.scope,
        generation: runtime.generation,
        exitCode: event.exitCode ?? null,
        signal: event.signal ?? null,
      });
    });

    return { ...this.attachment(runtime), created: true };
  }

  private attachment(runtime: Runtime): ConversationTerminalAttachment {
    return {
      terminalId: runtime.terminalId,
      key: runtime.key,
      scope: runtime.scope,
      generation: runtime.generation,
      cols: runtime.cols,
      rows: runtime.rows,
      visible: runtime.visible,
      shell: runtime.shell,
      scrollback: runtime.scrollback.read(),
    };
  }

  private currentRuntime(
    key: ConversationKey,
    terminalId: string,
    expectedGeneration?: number
  ): Runtime | null {
    const runtime = this.runtimes.get(runtimeKey(key, terminalId));
    if (runtime == null) return null;
    if (
      expectedGeneration != null &&
      runtime.generation !== expectedGeneration
    ) {
      return null;
    }
    return runtime;
  }

  private isCurrent(runtime: Runtime): boolean {
    return (
      this.runtimes.get(runtimeKey(runtime.key, runtime.terminalId)) ===
        runtime &&
      this.generations.get(runtimeKey(runtime.key, runtime.terminalId)) ===
        runtime.generation
    );
  }

  private nextGeneration(key: string): number {
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    return generation;
  }

  private invalidate(key: string): void {
    this.nextGeneration(key);
  }
}
