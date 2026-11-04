/**
 * The sessions chat's files card: after a finished turn's last assistant
 * message, the files the turn handed over (`present_deliverable`, else its
 * user-facing file writes), each opening in the right-panel preview. The
 * derivation is the bots' (`lib/bot-turns/deliverables`) so both agree.
 */
import type { UIMessage } from "@tanstack/ai-client";
import type { ReactNode } from "react";

import {
  DeliverablesCard,
  resolveWorkspacePath,
} from "#renderer/components/file-preview";
import { ShareRowButton } from "#renderer/components/share/share-row-button";
import {
  turnDeliverables,
  type TurnDeliverable,
} from "#renderer/lib/bot-turns/deliverables";
import { turnsOf } from "#renderer/lib/bot-turns/turns";

const cache = new WeakMap<
  readonly UIMessage[],
  Map<number, TurnDeliverable[]>
>();

const byCarrier = (
  messages: readonly UIMessage[]
): Map<number, TurnDeliverable[]> => {
  const hit = cache.get(messages);
  if (hit != null) return hit;
  const map = new Map<number, TurnDeliverable[]>();
  for (const turn of turnsOf(messages)) {
    const items = turnDeliverables(
      turn.assistantIndices.map((index) => messages[index]!)
    );
    const carrier = turn.assistantIndices.at(-1);
    if (items.length > 0 && carrier != null) map.set(carrier, items);
  }
  cache.set(messages, map);
  return map;
};

/**
 * The deliverables to show after `messages[index]`: only on a turn's last
 * assistant message, and never while that turn is still running.
 */
export const deliverablesAfter = (
  messages: readonly UIMessage[],
  index: number,
  runActive: boolean
): TurnDeliverable[] | null => {
  const items = byCarrier(messages).get(index);
  if (items == null) return null;
  const lastTurnOpen =
    runActive &&
    !messages.slice(index + 1).some((message) => message.role === "user");
  return lastTurnOpen ? null : items;
};

export interface SessionDeliverablesOptions {
  workspaceRoot: string | null;
  /** Open a file (absolute) in the right-panel preview. */
  onOpenFile(absPath: string): void;
  /** Open a URL in the panel's browser tab. */
  onOpenUrl(url: string): void;
  /** "Open in browser": the system browser. */
  onOpenExternal(url: string): void;
  onReveal?(absPath: string): void;
}

export const sessionDeliverablesCard = (
  items: readonly TurnDeliverable[],
  options: SessionDeliverablesOptions
): ReactNode => {
  const resolve = (path: string): string =>
    resolveWorkspacePath(path, options.workspaceRoot);
  return (
    <DeliverablesCard
      items={items}
      onOpen={(item) =>
        item.isUrl
          ? options.onOpenUrl(item.path)
          : options.onOpenFile(resolve(item.path))
      }
      onReveal={
        options.onReveal
          ? (item) => options.onReveal?.(resolve(item.path))
          : undefined
      }
      onOpenUrl={(item) => options.onOpenExternal(item.path)}
      rowAction={(item) =>
        item.isUrl ? null : <ShareRowButton path={resolve(item.path)} />
      }
    />
  );
};

/**
 * The index of the last message a row stands for: a coalesced row carries its
 * host's id, but the messages folded into it come later in the thread.
 * `-1` when the row is not in `context.messages`.
 */
export const rowEndIndex = (
  message: UIMessage,
  context: { messages: readonly UIMessage[]; index: number }
): number => {
  const indexOf = (id: string): number =>
    context.messages[context.index]?.id === id
      ? context.index
      : context.messages.findIndex((row) => row.id === id);
  const host = indexOf(message.id);
  if (host < 0) return -1;
  let end = host;
  for (const id of (
    message.metadata as { abacus?: { coalescedIds?: string[] } } | undefined
  )?.abacus?.coalescedIds ?? [])
    end = Math.max(
      end,
      context.messages.findIndex((row) => row.id === id)
    );
  return end;
};
