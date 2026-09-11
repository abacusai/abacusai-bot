/**
 * Notices that describe one thing as it changes, rather than a series of
 * separate events.
 *
 * The case that made this necessary: OpenLLM walking a pool of rate-limited
 * free models wrote a warning and a paragraph of provider text per model, and
 * five of those pushed the user's question off the screen before the answer
 * arrived. Keyed notices are one line being rewritten instead.
 */
import { describe, expect, it } from "vitest";

import {
  conversationReducer,
  createInitialConversationState,
} from "./conversation-reducer";
import type { ConversationState, NotificationSegment } from "./types";

const notify = (
  state: ConversationState,
  message: string,
  extra: Record<string, unknown> = {}
): ConversationState =>
  conversationReducer(state, {
    kind: "event",
    event: { type: "notification", severity: "info", message, ...extra },
  });

const notifications = (state: ConversationState): NotificationSegment[] =>
  state.segments.filter(
    (segment): segment is NotificationSegment => segment.type === "notification"
  );

describe("keyed notifications", () => {
  it("rewrites one line instead of stacking a banner per step", () => {
    let state = createInitialConversationState();
    state = notify(state, "Routing to a/one…", {
      notificationKey: "routing-1",
    });
    state = notify(state, "a/one failed (429) — routing to a/two…", {
      notificationKey: "routing-1",
      severity: "warning",
    });
    state = notify(state, "Routed to a/two.", { notificationKey: "routing-1" });

    expect(notifications(state).map((segment) => segment.message)).toEqual([
      "Routed to a/two.",
    ]);
  });

  it("keeps the line's id so the banner updates rather than remounting", () => {
    let state = createInitialConversationState();
    state = notify(state, "Routing to a/one…", {
      notificationKey: "routing-1",
    });
    const first = notifications(state)[0]?.id;

    state = notify(state, "Routed to a/one.", { notificationKey: "routing-1" });

    expect(notifications(state)[0]?.id).toBe(first);
  });

  it("rewrites the line in place, leaving later output below it", () => {
    let state = createInitialConversationState();
    state = notify(state, "Routing to a/one…", {
      notificationKey: "routing-1",
    });
    state = notify(state, "unrelated");
    state = notify(state, "Routed to a/one.", { notificationKey: "routing-1" });

    expect(notifications(state).map((segment) => segment.message)).toEqual([
      "Routed to a/one.",
      "unrelated",
    ]);
  });

  it("gives a second episode its own line", () => {
    let state = createInitialConversationState();
    state = notify(state, "Routed to a/one.", { notificationKey: "routing-1" });
    state = notify(state, "Routing to a/two…", {
      notificationKey: "routing-2",
    });

    expect(notifications(state)).toHaveLength(2);
  });

  /**
   * The bug: keys are counted per agent process, so reopening a session starts
   * over at `openllm-routing-1` — the key an answer from days ago is already
   * saved under. Matching by key across the whole transcript found that old
   * line and rewrote it, so the routing notice for the turn the user had just
   * started appeared above an answer they had already read, and nowhere near
   * the answer it described.
   */
  it("does not rewrite a line an earlier turn wrote", () => {
    let state = createInitialConversationState();
    state = notify(state, "Routed to a/one.", {
      notificationKey: "openllm-routing-1",
    });
    state = conversationReducer(state, {
      kind: "user_message",
      content: "and now something else",
    });
    state = notify(state, "Routing to a/two…", {
      notificationKey: "openllm-routing-1",
    });

    expect(notifications(state).map((segment) => segment.message)).toEqual([
      "Routed to a/one.",
      "Routing to a/two…",
    ]);
  });

  it("does not rewrite a line restored from a saved session", () => {
    let state = createInitialConversationState();

    state = conversationReducer(state, {
      kind: "hydrate",
      segments: [
        {
          type: "text",
          id: "old-text",
          role: "user",
          content: "what did you route to?",
        },
        {
          type: "notification",
          id: "old-line",
          message: "Routed to a/one.",
          severity: "info",
          notificationKey: "openllm-routing-1",
        },
      ],
    });
    state = notify(state, "Routing to a/two…", {
      notificationKey: "openllm-routing-1",
    });

    expect(notifications(state).map((segment) => segment.message)).toEqual([
      "Routed to a/one.",
      "Routing to a/two…",
    ]);
  });

  it("leaves unkeyed notices alone — they are still separate events", () => {
    let state = createInitialConversationState();
    state = notify(state, "first");
    state = notify(state, "second");

    expect(notifications(state).map((segment) => segment.message)).toEqual([
      "first",
      "second",
    ]);
  });
});
