/**
 * Whose chat an agent process is, for memory: the one place that decides it
 * (packages/agent/src/memory/lanes.ts reads the result). Pure, so every kind
 * of session is covered by one table of tests.
 */
import { createHash } from "node:crypto";

import type { SessionOwner } from "@abacus-ai/contract/contracts";

export interface MemorySessionFacts {
  /** The Memory switch in Capabilities. */
  memoryOn: boolean;
  /** Someone else in a chat app with no bot: never the user's memory. */
  chatAppSender: boolean;
  owner: SessionOwner | null;
  /** Nobody is in this chat: a routine's run, a hosted run, a bot answering a bot. */
  nobodyPresent: boolean;
  /** The routine this session runs, when it runs one. */
  routine: { id: string; name: string; folder: string | null } | null;
  /** The bot this session belongs to, when it does. */
  bot: { id: string; name: string } | null;
  /** The folder the user picked for this chat; null for the app's own folders. */
  folder: { path: string; name: string } | null;
}

interface ProjectEnv {
  kind: "folder" | "bot" | "routine";
  key: string;
  name: string;
  path?: string;
}

const projectEnv = (project: ProjectEnv): Record<string, string> => ({
  ABACUSAI_BOT_MEMORY_PROJECT: JSON.stringify(project),
});

/** A sender's key as a folder name: readable, and unique per sender. */
export const contactFolder = (key: string, name: string | null): string => {
  const readable = (name ?? key)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 8);
  return `${readable.length > 0 ? readable : "contact"}-${hash}`;
};

export const memoryEnv = (
  facts: MemorySessionFacts
): Record<string, string> => {
  if (!facts.memoryOn) return { ABACUSAI_BOT_MEMORY: "off" };
  if (facts.chatAppSender) return { ABACUSAI_BOT_MEMORY: "sender" };

  const botProject =
    facts.bot != null
      ? projectEnv({ kind: "bot", key: facts.bot.id, name: facts.bot.name })
      : {};

  if (facts.owner?.role === "sender") {
    if (facts.bot == null || facts.owner.key == null)
      return { ABACUSAI_BOT_MEMORY: "sender" };
    return {
      ABACUSAI_BOT_MEMORY: "bot-sender",
      ABACUSAI_BOT_MEMORY_CONTACT: contactFolder(
        facts.owner.key,
        facts.owner.senderName ?? null
      ),
      ...botProject,
    };
  }

  if (facts.routine != null || facts.nobodyPresent) {
    const project =
      facts.bot != null
        ? botProject
        : facts.routine?.folder != null
          ? projectEnv({
              kind: "folder",
              key: facts.routine.folder,
              name: lastSegment(facts.routine.folder),
              path: facts.routine.folder,
            })
          : facts.routine != null
            ? projectEnv({
                kind: "routine",
                key: facts.routine.id,
                name: facts.routine.name,
              })
            : {};
    return { ABACUSAI_BOT_MEMORY: "routine", ...project };
  }

  if (facts.bot != null) return { ABACUSAI_BOT_MEMORY: "owner", ...botProject };
  if (facts.folder != null)
    return {
      ABACUSAI_BOT_MEMORY: "owner",
      ...projectEnv({
        kind: "folder",
        key: facts.folder.path,
        name: facts.folder.name,
        path: facts.folder.path,
      }),
    };
  return { ABACUSAI_BOT_MEMORY: "owner" };
};

const lastSegment = (folder: string): string =>
  folder
    .split(/[\\/]/)
    .filter((part) => part.length > 0)
    .pop() ?? folder;
