import type { AgentMode } from "../protocol.js";
/**
 * Memory for one running chat, the same for the desktop chat and the forever
 * chats (bots, the phone lane): the block for the system prompt, built once;
 * the tool; the hidden line before a turn when memory changed elsewhere; and
 * the check that an asked-for save happened.
 */
import { appNoteTag } from "../user-text.js";
import { askedToRemember } from "./asked.js";
import { memoryBlock, memoryNews } from "./core.js";
import {
  hasMemory,
  type MemoryContext,
  projectSlug,
  readMemoryContext,
  readsYou,
} from "./lanes.js";
import { migrateOnce } from "./migrate.js";
import { historyCursor, listNotes, SESSION_ID } from "./notes.js";
import { recallFor } from "./recall.js";

const SUB_AGENT_CHARS = 2_000;

const capText = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
import { buildMemoryTool } from "./tool.js";

/** The custom-message type of the hidden memory line before a turn. */
export const MEMORY_CONTEXT_TYPE = "abacusai-bot:memory-context";
/** The custom-message type of the one follow-up when an asked-for save did not happen. */
export const MEMORY_SAVE_CHECK_TYPE = "abacusai-bot:memory-save-check";

/** This process's chat, for sub-agents that run inside it. */
let current: ChatMemory | null = null;
const makeCurrent = (chat: ChatMemory): void => {
  current = chat;
};

/**
 * The user's rules and preferences for a sub-agent (a delegated task, a
 * document, a deck, a design, a browser run): "answer in British English"
 * must reach what they write too. Read-only, and empty for a chat that does
 * not read about the user.
 */
export const subAgentMemory = (): string[] => {
  const notes = current?.standingNotes() ?? null;
  return notes == null ? [] : [notes];
};

export class ChatMemory {
  readonly context: MemoryContext;
  private block: string | null = null;
  private cursor = "";
  private savedThisTurn = false;
  /** The project recall searches first: the chat's own, or the one it opened. */
  private slug: string | null = null;
  private readonly memoryTool: ReturnType<typeof buildMemoryTool>;

  constructor(
    cwd: string,
    mode: AgentMode | string,
    /** The user's own words, this turn and lately. */
    private readonly words: () => string,
    model: () => string | undefined
  ) {
    this.context = readMemoryContext(cwd, mode);
    this.memoryTool = buildMemoryTool(this.context, {
      userWords: words,
      model,
      saved: () => {
        this.savedThisTurn = true;
      },
      opened: (project) => {
        this.slug = project.slug;
      },
    });
  }

  /** Once, before the prompt is built. A failure leaves the chat without memory, never broken. */
  async start(): Promise<void> {
    if (!hasMemory(this.context)) return;
    try {
      await migrateOnce();
      this.block = await memoryBlock(this.context);
      this.cursor = historyCursor();
      this.slug = projectSlug(this.context);
      makeCurrent(this);
    } catch (error) {
      console.error("[memory] could not load:", error);
      this.block = null;
    }
  }

  /** The system-prompt block, frozen for the session; null when there is none. */
  prompt(): string | null {
    return this.block;
  }

  /** The user's rules and preferences, as of this chat's start; null when it has none. */
  standingNotes(): string | null {
    if (this.block == null || !readsYou(this.context)) return null;
    const notes = listNotes({ kind: "you" }).filter(
      (note) =>
        note.type === "rule" ||
        note.type === "preference" ||
        note.type === "profile"
    );
    if (notes.length === 0) return null;
    const lines = notes.map(
      (note) => `- ${note.body.replace(/\s*\r?\n\s*/g, " ")}`
    );
    return capText(
      [
        "The user's standing rules and preferences (follow them in what you produce):",
        ...lines,
      ].join("\n"),
      SUB_AGENT_CHARS
    );
  }

  /** The `memory` tool, or null when this chat has no memory. */
  tool(): ReturnType<typeof buildMemoryTool> {
    return this.memoryTool;
  }

  /**
   * At the start of a turn, the hidden line that rides with `message`: what
   * changed elsewhere since the last turn, and what memory holds that matches
   * it. "" when neither has anything.
   */
  beginTurn(message: string): string {
    this.savedThisTurn = false;
    if (!hasMemory(this.context) || this.block == null) return "";
    try {
      const news = memoryNews(this.context, this.cursor, SESSION_ID);
      this.cursor = news.cursor;
      const recalled = recallFor(this.context, this.slug, message);
      return [news.text, recalled]
        .filter((part) => part.length > 0)
        .join("\n\n");
    } catch (error) {
      console.error("[memory] recall failed:", error);
      return "";
    }
  }

  /**
   * After a turn: the follow-up to send when the user asked, in their own
   * words, for something to be kept and nothing was saved. Null otherwise.
   */
  saveCheck(ownWordsThisTurn: string): string | null {
    if (
      this.memoryTool == null ||
      this.context.unattended ||
      this.savedThisTurn ||
      !askedToRemember(ownWordsThisTurn)
    )
      return null;
    return `${appNoteTag("memory check")} The user asked you to remember something, and nothing was saved this turn. Save it now with the memory tool, or tell the user in one short sentence why you did not.`;
  }

  /** Whether the follow-up's own turn saved; read once it ran. */
  get saved(): boolean {
    return this.savedThisTurn;
  }
}

export { readMemoryContext };
