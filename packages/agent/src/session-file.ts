/**
 * The pi session a desktop conversation picks back up. The desktop restores a
 * transcript on screen, but the agent behind it is a new process with an empty
 * context; pi writes every session to disk and `SessionManager.setSessionFile`
 * points it back at one, so this only makes the path predictable: one file per
 * desktop session id. A terminal run sets no id and gets a new session.
 */
import fs from "fs";
import path from "path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { agentDir } from "./config.js";

/** Desktop session ids are uuids; anything else is not going in a path. */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

const sessionFileFor = (id: string): string | null => {
  if (!SAFE_ID.test(id)) return null;
  return path.join(agentDir(), "sessions", "desktop", `${id}.jsonl`);
};

/**
 * The session manager for this process, or undefined to let pi choose.
 * `fresh` is for the reset paths: clearing a conversation must not hand the
 * old transcript straight back, and the file is removed rather than left beside
 * a new one so the next restart resumes the conversation the user can see.
 */
export const conversationSessionManager = (
  cwd: string,
  { fresh = false }: { fresh?: boolean } = {}
): SessionManager | undefined => {
  const id = process.env.ABACUSAI_BOT_SESSION_ID;
  if (id == null || id.length === 0) return undefined;

  const file = sessionFileFor(id);
  if (file == null) return undefined;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fresh) fs.rmSync(file, { force: true });

    const manager = SessionManager.create(cwd, path.dirname(file));
    // Throws on a file that exists but is not a pi session. A corrupt record
    // must cost the history, never the chat.
    manager.setSessionFile(file);

    return manager;
  } catch (error) {
    console.error(
      `[session] could not resume ${file}: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
};
