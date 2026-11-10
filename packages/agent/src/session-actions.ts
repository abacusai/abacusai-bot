/**
 * The commands a user runs on the agent itself rather than sends to it: pi
 * has each of these, but only its own terminal reaches them. Nothing here
 * starts a turn; `compact` and `handoff` call a model, and only `compact`
 * changes the history.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { liveBackgroundJobCount } from "./background-processes.js";
import type { Summarizer } from "./extensions/spend-governor.js";
import { handoffSummary } from "./handoff-summary.js";
import type { SessionAction, SessionActionResult } from "./protocol.js";
import { listServed } from "./static-server.js";

/** Plain text of a message: the transcript's words, without tool calls. */
const messageText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((part: { type?: string; text?: string }) =>
            part.type === "text" && part.text != null ? [part.text] : []
          )
          .join("\n")
      : "";

const exportChat = async (
  session: AgentSession,
  cwd: string
): Promise<SessionActionResult> => {
  const lines = session.messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = messageText(message.content).trim();
    return text === "" ? [] : [`## ${message.role}\n\n${text}\n`];
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(cwd, `chat-export-${stamp}.md`);
  await writeFile(path, lines.join("\n"), "utf8");
  return { ok: true, path };
};

export const runSessionAction = async (
  session: AgentSession | undefined,
  cwd: string,
  action: SessionAction,
  value: string | undefined,
  summarizerFor: (tokens: number) => Promise<Summarizer | null> = () =>
    Promise.resolve(null)
): Promise<SessionActionResult> => {
  if (action === "tasks")
    return { ok: true, live: liveBackgroundJobCount() + listServed().length };
  if (session == null) return { ok: false, reason: "not-running" };
  switch (action) {
    case "compact":
      try {
        await session.compact(value);
      } catch (error) {
        // pi's own wording is all that tells a short chat from a failed call.
        if (String(error).includes("Nothing to compact"))
          return { ok: false, reason: "too-small" };
        throw error;
      }
      return { ok: true };
    case "context":
      return { ok: true, percent: session.getContextUsage()?.percent ?? null };
    case "effort": {
      if (value != null) {
        const level = session
          .getAvailableThinkingLevels()
          .find((available) => available === value);
        if (level == null) return { ok: false, reason: "invalid" };
        session.setThinkingLevel(level);
      }
      return { ok: true, level: session.thinkingLevel };
    }
    case "autocompact":
      if (value !== "on" && value !== "off")
        return { ok: false, reason: "invalid" };
      session.setAutoCompactionEnabled(value === "on");
      return { ok: true };
    case "export":
      return exportChat(session, cwd);
    case "handoff": {
      const entries = session.sessionManager.getBranch();
      if (!entries.some((entry) => entry.type === "message"))
        return { ok: false, reason: "too-small" };
      const summary = await handoffSummary(entries, summarizerFor);
      return summary == null
        ? { ok: false, reason: "failed" }
        : { ok: true, summary };
    }
  }
};
