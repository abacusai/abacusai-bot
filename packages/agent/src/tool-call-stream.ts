/**
 * Tool calls as the provider streams them (spec 00-agent-agui §3.3.5), turned
 * into the internal `tool_call_*` events for the AG-UI emitter.
 *
 * pi's AssistantMessageEvent shapes (0.85.1 and 0.99.1 alike):
 *   toolcall_start  {contentIndex, partial}
 *   toolcall_delta  {contentIndex, delta, partial}
 *   toolcall_end    {contentIndex, toolCall, partial}
 * The call is read from `partial.content[contentIndex]`; a start whose id is
 * not known yet is deferred to the first delta (or the end) that has one.
 */
import type { InternalAgentEvent } from "./internal-events.js";

interface ToolCallBlock {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

type StreamEvent = {
  type: string;
  contentIndex?: number;
  delta?: string;
  partial?: { content?: unknown[] };
  toolCall?: ToolCallBlock;
};

const blockAt = (event: StreamEvent): ToolCallBlock | undefined => {
  const content = event.partial?.content;
  const index = event.contentIndex;

  if (!Array.isArray(content) || typeof index !== "number") return undefined;

  const block = content[index] as ToolCallBlock | undefined;

  return block?.type === "toolCall" ? block : undefined;
};

const idOf = (block: ToolCallBlock | undefined): string | undefined =>
  typeof block?.id === "string" && block.id.length > 0 ? block.id : undefined;

const objectOr = (value: unknown): Record<string, unknown> | undefined =>
  value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export class ToolCallStream {
  /** contentIndex → announced id. */
  private readonly ids = new Map<number, string>();
  /** contentIndex → deltas that arrived before the id did. */
  private readonly deferred = new Map<number, string[]>();

  constructor(private readonly displayName: (raw: string) => string) {}

  /** A new assistant message: content indexes start over. */
  reset(): void {
    this.ids.clear();
    this.deferred.clear();
  }

  handle(event: StreamEvent): InternalAgentEvent[] {
    const index = event.contentIndex;

    if (typeof index !== "number") return [];

    switch (event.type) {
      case "toolcall_start": {
        const block = blockAt(event);
        const id = idOf(block);

        if (id == null) {
          this.deferred.set(index, []);

          return [];
        }

        return this.announce(index, id, block);
      }

      case "toolcall_delta": {
        const delta = event.delta ?? "";
        const known = this.ids.get(index);

        if (known != null) {
          return delta.length > 0
            ? [
                {
                  type: "tool_call_delta",
                  toolCallId: known,
                  argumentsDelta: delta,
                },
              ]
            : [];
        }

        const block = blockAt(event);
        const id = idOf(block);

        if (id == null) {
          const buffered = this.deferred.get(index) ?? [];

          if (delta.length > 0) buffered.push(delta);
          this.deferred.set(index, buffered);

          return [];
        }

        // The delta that revealed the id is already part of the buffer's
        // successor: announce, replay what was held, then this one.
        const out = this.announce(index, id, block);

        if (delta.length > 0) {
          out.push({
            type: "tool_call_delta",
            toolCallId: id,
            argumentsDelta: delta,
          });
        }

        return out;
      }

      case "toolcall_end": {
        const call = event.toolCall ?? blockAt(event);
        const id = idOf(call) ?? this.ids.get(index);

        if (id == null) return [];

        const out: InternalAgentEvent[] = this.ids.has(index)
          ? []
          : this.announce(index, id, call);
        const name = typeof call?.name === "string" ? call.name : "";

        out.push({
          type: "tool_call_stop",
          toolCallId: id,
          toolName: this.displayName(name),
          arguments: JSON.stringify(objectOr(call?.arguments) ?? {}),
        });
        this.ids.delete(index);

        return out;
      }

      default:
        return [];
    }
  }

  private announce(
    index: number,
    id: string,
    block: ToolCallBlock | undefined
  ): InternalAgentEvent[] {
    const raw = typeof block?.name === "string" ? block.name : "";
    const input = objectOr(block?.arguments);
    const out: InternalAgentEvent[] = [
      {
        type: "tool_call_start",
        toolCallId: id,
        toolName: this.displayName(raw),
        rawName: raw,
        ...(input != null ? { input } : {}),
      },
    ];

    this.ids.set(index, id);

    for (const delta of this.deferred.get(index) ?? []) {
      out.push({
        type: "tool_call_delta",
        toolCallId: id,
        argumentsDelta: delta,
      });
    }
    this.deferred.delete(index);

    return out;
  }
}
