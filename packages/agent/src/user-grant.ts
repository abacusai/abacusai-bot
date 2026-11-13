/**
 * The user's own words, stamped on every browser call by this process: what
 * the browser lets a run upload, and which address on this computer or its
 * network it may open (the desktop's user-grant.ts reads it). A page can
 * write anything the sub-agent reads; it cannot write this. The stamp carries
 * the capability only this process and the desktop hold, and any `user_grant`
 * the model wrote is replaced or dropped.
 */
import type { UserTextTags } from "./protocol.js";
import { userTurnText } from "./user-text.js";

/** The user's last few messages, attachments kept. */
export class UserSaid {
  private texts: string[] = [];

  constructor(private readonly keep = 6) {}

  /** A turn's text, or a message steered in mid-turn. */
  note(text: string, tags?: UserTextTags): void {
    const own = userTurnText(text, tags);
    if (own.length === 0) return;
    this.texts.push(own);
    if (this.texts.length > this.keep) this.texts.shift();
  }

  read(): readonly string[] {
    return this.texts;
  }

  clear(): void {
    this.texts = [];
  }
}

/** This process's conversation: one user, one browser. */
export const userSaid = new UserSaid();

/** The stamp the browser reads; null when this process holds no capability. */
export type UserGrantStamp = {
  token: string;
  said: readonly string[];
  start_url?: string;
} | null;

type ToolLike = { name?: unknown; execute?: unknown };

/** The tools, each browser call carrying `grant()` as `user_grant` and nothing a model wrote there. */
export function stampUserGrant(
  tools: unknown[],
  grant: () => UserGrantStamp
): unknown[] {
  return tools.map((tool) => {
    const original = (tool as ToolLike).execute;
    if (typeof original !== "function") return tool;
    const browser =
      typeof (tool as ToolLike).name === "string" &&
      ((tool as ToolLike).name as string).startsWith("browser_");
    return {
      ...(tool as object),
      execute: (...args: unknown[]) => {
        const params = args[1];
        if (params != null && typeof params === "object") {
          const { user_grant: _dropped, ...rest } = params as Record<
            string,
            unknown
          >;
          const stamp = browser ? grant() : null;
          args[1] = stamp == null ? rest : { ...rest, user_grant: stamp };
        }
        return (original as (...a: unknown[]) => unknown).apply(tool, args);
      },
    };
  });
}
