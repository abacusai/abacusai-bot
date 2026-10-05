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

/**
 * Why a generation ended without its own exit: closed (explicitly, or with
 * its scope or workspace), or superseded by a scope promotion that moved the
 * shell to a new key and generation.
 */
export type TerminalRetireReason = "closed" | "superseded";

export type ConversationTerminalRetireEvent = ConversationTerminalEvent & {
  reason: TerminalRetireReason;
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
  /**
   * A generation that ends without `onExit`: `close` and the disposals
   * invalidate it before killing the PTY (so its exit is suppressed), and a
   * promotion re-keys it. Readers of that generation end on this.
   */
  onRetire?: (event: ConversationTerminalRetireEvent) => void;
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

/** Where a terminal's output stands, for a reader resuming by offset. */
export type ConversationTerminalOutputState = {
  /** The output after `from`: the delta asked for, or the whole scrollback. */
  data: string;
  from: number;
  /** The offset after `data`. */
  offset: number;
  /** Set once the shell exited; sticky for a reader that arrives late. */
  exit: { exitCode: number | null; signal: number | null } | null;
  /** Set once the generation was closed or superseded; sticky likewise. */
  retired: TerminalRetireReason | null;
};

type ExitedRuntime = {
  generation: number;
  scrollback: BoundedScrollback;
  exitCode: number | null;
  signal: number | null;
  retired: TerminalRetireReason | null;
};

const DEFAULT_SCROLLBACK_BYTES = 2 * 1024 * 1024;
/** Exited terminals kept for late readers, oldest dropped first. */
const MAX_EXITED_RUNTIMES = 8;
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
  /** Every byte ever appended, evicted or not: the offset of the next byte. */
  private endOffset = 0;

  constructor(readonly maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new Error("maximumBytes must be a positive safe integer.");
    }
  }

  /**
   * Offsets address the terminal's whole output as UTF-8 bytes, so a reader
   * that saw up to `end` can ask for exactly what came after.
   */
  get end(): number {
    return this.endOffset;
  }

  /** The offset of the oldest byte still held. */
  get start(): number {
    return this.endOffset - this.byteLength;
  }

  /** The output after `offset`, or null when part of it was evicted. */
  readFrom(offset: number): string | null {
    if (!Number.isSafeInteger(offset) || offset < this.start) return null;
    if (offset > this.endOffset) return null;
    return Buffer.concat(this.chunks, this.byteLength)
      .subarray(offset - this.start)
      .toString("utf8");
  }

  append(value: string): void {
    const bytes = Buffer.from(value, "utf8");
    this.endOffset += bytes.length;
    let chunk = safeUtf8Suffix(bytes, this.maximumBytes);
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

  /** A frozen copy with the same offsets. */
  clone(): BoundedScrollback {
    const copy = new BoundedScrollback(this.maximumBytes);
    copy.chunks = [...this.chunks];
    copy.byteLength = this.byteLength;
    copy.endOffset = this.endOffset;
    return copy;
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
  private readonly exited = new Map<string, ExitedRuntime>();
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
   * shell, but a live one counts even sitting at a prompt, because from here
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

  /** Every running terminal, in every conversation. */
  listAll(): ConversationTerminalAttachment[] {
    return [...this.runtimes.values()].map((runtime) =>
      this.attachment(runtime)
    );
  }

  /**
   * One generation's output from `fromOffset` (the whole scrollback when it
   * is absent or evicted), and its exit once it exited. Null for a terminal
   * this registry never ran or has forgotten.
   */
  outputState(
    key: ConversationKey,
    generation: number,
    terminalId = DEFAULT_TERMINAL_ID,
    fromOffset?: number
  ): ConversationTerminalOutputState | null {
    const runtime = this.currentRuntime(key, terminalId, generation);
    const exited = this.exited.get(runtimeKey(key, terminalId));
    const record =
      runtime ?? (exited?.generation === generation ? exited : null);
    if (record == null) return null;

    const { scrollback } = record;
    const delta = fromOffset == null ? null : scrollback.readFrom(fromOffset);
    const ended = runtime == null ? exited : null;
    return {
      data: delta ?? scrollback.read(),
      from: delta == null ? scrollback.start : fromOffset!,
      offset: scrollback.end,
      exit:
        ended == null || ended.retired != null
          ? null
          : { exitCode: ended.exitCode, signal: ended.signal },
      retired: ended?.retired ?? null,
    };
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
      // Its exit is suppressed from here on (it is no longer current), so
      // readers of this generation are told now.
      this.retire(runtime, "closed");
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
      // The draft's generation ends here; the shell carries on under the
      // session's key and a new generation.
      this.retire(source, "superseded");
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
      const id = runtimeKey(runtime.key, runtime.terminalId);
      this.runtimes.delete(id);
      this.remember(id, {
        generation: runtime.generation,
        scrollback: runtime.scrollback,
        exitCode: event.exitCode ?? null,
        signal: event.signal ?? null,
        retired: null,
      });
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

  /**
   * Kept briefly, so a reader that arrives after the end still gets the
   * output and how it ended rather than nothing.
   */
  private remember(id: string, record: ExitedRuntime): void {
    this.exited.delete(id);
    this.exited.set(id, record);
    if (this.exited.size > MAX_EXITED_RUNTIMES) {
      const oldest = this.exited.keys().next().value;
      if (oldest != null) this.exited.delete(oldest);
    }
  }

  /** Call before `runtime`'s key or generation changes. */
  private retire(runtime: Runtime, reason: TerminalRetireReason): void {
    this.remember(runtimeKey(runtime.key, runtime.terminalId), {
      generation: runtime.generation,
      // A copy: a promoted shell keeps appending to the original.
      scrollback: runtime.scrollback.clone(),
      exitCode: null,
      signal: null,
      retired: reason,
    });
    this.options.onRetire?.({
      terminalId: runtime.terminalId,
      key: runtime.key,
      scope: runtime.scope,
      generation: runtime.generation,
      reason,
    });
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
