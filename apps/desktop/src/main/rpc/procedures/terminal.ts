import type { TerminalEvent, TerminalOutputChunk } from "#shared/contract";

import { notFound } from "../errors";
import { impl, isType, onIpcEvents, stream } from "./impl";

const DEFAULT_TERMINAL_ID = "terminal-1";

const utf8Length = (data: string): number => Buffer.byteLength(data, "utf8");

/** A chunk's pending size against the 8 MB cap: UTF-8 bytes, as offsets are. */
export const terminalChunkSize = (chunk: TerminalOutputChunk): number =>
  chunk.type === "data" || chunk.type === "snapshot"
    ? utf8Length(chunk.data)
    : 0;

export const terminalRouter = impl.terminal.router({
  start: impl.terminal.start.handler(({ input, context }) =>
    context.deps.serviceHost.startTerminalSession(input)
  ),
  write: impl.terminal.write.handler(({ input, context }) =>
    context.deps.serviceHost.writeTerminalInput(input)
  ),
  resize: impl.terminal.resize.handler(({ input, context }) =>
    context.deps.serviceHost.resizeTerminalSession(input)
  ),
  hide: impl.terminal.hide.handler(({ input, context }) =>
    context.deps.serviceHost.hideTerminalSession(input)
  ),
  promoteScope: impl.terminal.promoteScope.handler(({ input, context }) =>
    context.deps.serviceHost.promoteTerminalSessionScope(input)
  ),
  shell: {
    get: impl.terminal.shell.get.handler(({ context }) =>
      context.deps.serviceHost.getTerminalShellState()
    ),
    set: impl.terminal.shell.set.handler(({ input, context }) =>
      context.deps.serviceHost.setTerminalShell(input.shell)
    ),
  },
  /**
   * Lossless and offset-addressed: `snapshot` first, then `data` chunks whose
   * `offset` is the cumulative byte count, then exactly one `exit` or
   * `retired` (closed, disposed, or superseded by a scope promotion). The
   * listeners are attached before the snapshot is read, in the same tick, so
   * every chunk after the snapshot's offset is in the queue.
   */
  output: impl.terminal.output.handler(({ input, context, signal }) => {
    const terminalId = input.terminalId ?? DEFAULT_TERMINAL_ID;
    const { serviceHost } = context.deps;
    let offset = 0;
    let endStream = (): void => undefined;

    return stream<TerminalOutputChunk>({
      path: "terminal.output",
      context,
      signal,
      attach: (push, end) => {
        endStream = end;
        const stopRetired = context.deps.bus.listenChannel(
          "terminal-retired",
          (event) => {
            if (
              event.conversationKey !== input.conversationKey ||
              event.terminalId !== terminalId ||
              event.generation !== input.generation
            )
              return;
            push({ type: "retired", reason: event.reason });
            end();
          }
        );
        const stopEvents = context.deps.bus.listen(
          (event) =>
            (event.type === "terminal-output" ||
              event.type === "terminal-exited") &&
            event.conversationKey === input.conversationKey &&
            event.terminalId === terminalId &&
            event.generation === input.generation,
          (event) => {
            if (event.type === "terminal-output") {
              offset += utf8Length(event.data);
              push({ type: "data", data: event.data, offset });
            } else if (event.type === "terminal-exited") {
              push({
                type: "exit",
                exitCode: event.exitCode,
                signal: event.signal,
              });
              end();
            }
          }
        );
        return () => {
          stopRetired();
          stopEvents();
        };
      },
      initial: () => {
        const state = serviceHost.terminalOutputState({
          conversationKey: input.conversationKey,
          terminalId,
          generation: input.generation,
          ...(input.fromOffset == null ? {} : { fromOffset: input.fromOffset }),
        });
        if (state == null) throw notFound("terminal", terminalId);
        offset = state.offset;
        const snapshot: TerminalOutputChunk = {
          type: "snapshot",
          data: state.data,
          from: state.from,
          offset: state.offset,
        };
        // Exit and retirement are sticky: a reader arriving after either
        // gets it straight away, and the stream then returns.
        if (state.retired != null) {
          endStream();
          return [snapshot, { type: "retired", reason: state.retired }];
        }
        if (state.exit == null) return [snapshot];
        endStream();
        return [snapshot, { type: "exit", ...state.exit }];
      },
      sizeOf: terminalChunkSize,
    });
  }),
  events: impl.terminal.events.handler(({ input, context, signal }) => {
    const key = input?.conversationKey;
    return stream<TerminalEvent>({
      path: "terminal.events",
      context,
      signal,
      attach: onIpcEvents(
        context,
        (event) =>
          isType("terminal-state-updated")(event) &&
          (key == null || event.conversationKey === key),
        (event) =>
          event.type === "terminal-state-updated"
            ? { type: "state" as const, state: event.state }
            : null
      ),
      initial: () => [
        {
          type: "snapshot",
          states: context.deps.serviceHost.listTerminalStates(key),
        },
      ],
    });
  }),
});
