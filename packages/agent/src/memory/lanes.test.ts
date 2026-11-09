/**
 * Who may read and write which memory: one row per kind of chat. A sender in a
 * chat app must never reach the user's notes; the switch off means nothing.
 */
import { describe, expect, it } from "vitest";

import { AgentMode } from "../protocol.js";
import {
  hasMemory,
  type Lane,
  mayRead,
  mayWrite,
  readMemoryContext,
  readsYou,
} from "./lanes.js";
import type { Scope } from "./notes.js";

const YOU: Scope = { kind: "you" };
const OWN: Scope = { kind: "project", slug: "shop" };
const OTHER: Scope = { kind: "project", slug: "blog" };
const CONTACT: Scope = { kind: "contact", slug: "shop", contact: "lead-1" };
const OTHER_CONTACT: Scope = {
  kind: "contact",
  slug: "shop",
  contact: "lead-2",
};

const context = (lane: Lane, unattended = false) =>
  readMemoryContext("/tmp/x", unattended ? AgentMode.Unattended : "default", {
    ABACUSAI_BOT_MEMORY: lane,
    ABACUSAI_BOT_MEMORY_PROJECT: JSON.stringify({
      kind: "bot",
      key: "b1",
      name: "Shop",
    }),
    ABACUSAI_BOT_MEMORY_CONTACT: "lead-1",
  });

const ROWS: Array<{
  chat: string;
  lane: Lane;
  unattended?: boolean;
  memory: boolean;
  you: boolean;
  writes: Scope[];
  reads: Scope[];
  never: Scope[];
}> = [
  {
    chat: "the user's own chat",
    lane: "owner",
    memory: true,
    you: true,
    writes: [YOU, OWN, OTHER],
    reads: [YOU, OWN, OTHER],
    never: [CONTACT],
  },
  {
    chat: "a run nobody watches",
    lane: "owner",
    unattended: true,
    memory: true,
    you: false,
    writes: [],
    reads: [OWN],
    never: [YOU, OTHER],
  },
  {
    chat: "a routine run",
    lane: "routine",
    memory: true,
    you: false,
    writes: [OWN],
    reads: [OWN],
    never: [YOU, OTHER, CONTACT],
  },
  {
    chat: "an unattended routine run",
    lane: "routine",
    unattended: true,
    memory: true,
    you: false,
    writes: [],
    reads: [OWN],
    never: [YOU, OTHER],
  },
  {
    chat: "someone else talking to the bot",
    lane: "bot-sender",
    memory: true,
    you: false,
    writes: [CONTACT],
    reads: [OWN, CONTACT],
    never: [YOU, OTHER, OTHER_CONTACT],
  },
  {
    chat: "someone else in a chat app",
    lane: "sender",
    memory: false,
    you: false,
    writes: [],
    reads: [],
    never: [YOU, OWN, OTHER, CONTACT],
  },
  {
    chat: "the switch off",
    lane: "off",
    memory: false,
    you: false,
    writes: [],
    reads: [],
    never: [YOU, OWN, OTHER, CONTACT],
  },
];

describe("memory lanes", () => {
  it.each(ROWS)("$chat", (row) => {
    const ctx = context(row.lane, row.unattended);
    expect(hasMemory(ctx)).toBe(row.memory);
    expect(readsYou(ctx)).toBe(row.you);
    for (const scope of row.writes)
      expect(mayWrite(ctx, scope, "shop"), JSON.stringify(scope)).toBe(true);
    for (const scope of row.reads)
      expect(mayRead(ctx, scope, "shop"), JSON.stringify(scope)).toBe(true);
    for (const scope of row.never) {
      expect(mayWrite(ctx, scope, "shop"), JSON.stringify(scope)).toBe(false);
      if (row.lane !== "owner" || scope.kind === "contact")
        expect(mayRead(ctx, scope, "shop"), JSON.stringify(scope)).toBe(false);
    }
  });

  it("treats a sender chat with no contact as a plain sender", () => {
    const ctx = readMemoryContext("/tmp/x", "default", {
      ABACUSAI_BOT_MEMORY: "bot-sender",
    });
    expect(ctx.lane).toBe("sender");
  });

  it("works in the folder it was started in when no app says otherwise", () => {
    const ctx = readMemoryContext("/tmp/my-site", "default", {});
    expect(ctx.lane).toBe("owner");
    expect(ctx.project).toMatchObject({ kind: "folder", name: "my-site" });
  });

  it("ignores a malformed project", () => {
    const ctx = readMemoryContext("/tmp/x", "default", {
      ABACUSAI_BOT_MEMORY: "owner",
      ABACUSAI_BOT_MEMORY_PROJECT: "{not json",
    });
    expect(ctx.project).toBeNull();
  });
});
