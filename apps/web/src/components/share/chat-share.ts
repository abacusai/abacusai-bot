/**
 * The file a chat offers to share as a whole (its header button): picked from
 * every turn's files the way the files cards list them.
 */
import { preferredShare } from "@abacus-ai/contract/share";
import type { UIMessage } from "@tanstack/ai-client";

import { resolveWorkspacePath } from "#renderer/components/file-preview";
import { turnDeliverables } from "#renderer/lib/bot-turns/deliverables";
import { turnsOf } from "#renderer/lib/bot-turns/turns";

const cache = new WeakMap<readonly UIMessage[], string[]>();

/** Every file the chat's turns handed over, oldest first, as written. */
const chatFiles = (messages: readonly UIMessage[]): string[] => {
  const hit = cache.get(messages);
  if (hit != null) return hit;
  const files = turnsOf(messages).flatMap((turn) =>
    turnDeliverables(turn.assistantIndices.map((index) => messages[index]!))
      .filter((item) => !item.isUrl)
      .map((item) => item.path)
  );
  cache.set(messages, files);
  return files;
};

/** The chat's file to share (absolute), or null when it made none. */
export const chatSharePath = (
  messages: readonly UIMessage[],
  workspaceRoot: string | null
): string | null => {
  const path = preferredShare(chatFiles(messages));
  return path == null ? null : resolveWorkspacePath(path, workspaceRoot);
};
