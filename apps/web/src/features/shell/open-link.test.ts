import { describe, expect, it } from "vitest";

import { createHarness } from "#renderer/test-support/app-harness";

import { chatTarget, draftWithText } from "./open-link";

const rows: Record<string, unknown> = {
  plain: { owner: null, routineId: null, editorFor: null },
  forever: {
    owner: { kind: "bot", botId: "b", role: "forever", key: "forever" },
    routineId: null,
    editorFor: null,
  },
  run: { owner: null, routineId: "r", editorFor: null },
  editor: { owner: null, routineId: null, editorFor: "r" },
};
const db = {
  collections: { sessions: { get: (id: string) => rows[id] } },
} as never;

describe("chatTarget", () => {
  it.each<[string | null, string, string | null]>([
    ["plain", "/sessions/plain", "plain"],
    // A bot's chat opens in its bot, and its composer still takes the draft.
    ["forever", "/bots/b", "forever"],
    // Unknown, or a chat a link must not open: home, no error.
    ["unknown", "/bots/new", null],
    ["run", "/bots/new", null],
    ["editor", "/bots/new", null],
    [null, "/bots/new", null],
  ])("a link to %s opens %s", async (sessionId, href, drafted) => {
    const app = await createHarness("/bots/new");
    try {
      const target = chatTarget(sessionId, db);
      expect(app.router.buildLocation(target.options).href).toBe(href);
      expect(target.sessionId).toBe(drafted);
    } finally {
      await app.cleanup();
    }
  });
});

describe("draftWithText", () => {
  it("fills an empty composer, keeping its attachments", () => {
    expect(draftWithText(undefined, "Add my menu")).toMatchObject({
      text: "Add my menu",
      attachments: [],
    });
    const attachments = [
      { id: "a", name: "a.png", path: null, state: "done" as const },
    ];
    expect(
      draftWithText({ text: "  ", attachments }, "Add my menu")
    ).toMatchObject({ text: "Add my menu", attachments });
  });

  it("never replaces what the user typed", () => {
    expect(
      draftWithText({ text: "my own words", attachments: [] }, "Add my menu")
    ).toBeNull();
  });
});
