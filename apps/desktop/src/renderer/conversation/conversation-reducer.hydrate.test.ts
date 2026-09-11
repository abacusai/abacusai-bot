/**
 * A transcript restore replaces history, not what the agent is waiting on.
 */
import { describe, expect, it } from "vitest";

import {
  conversationReducer,
  createInitialConversationState,
} from "./conversation-reducer";
import type { PermissionPrompt } from "./types";

const prompt: PermissionPrompt = {
  request: {
    type: "generic",
    toolName: "document",
    inputSummary: "mughal-empire.pdf",
    displayName: "Document",
    tool: { id: "call-1", name: "document", args: {}, status: "pending" },
  } as unknown as PermissionPrompt["request"],
};

describe("restoring a transcript", () => {
  it("keeps the approval the agent is still waiting on", () => {
    let state = createInitialConversationState();
    state = conversationReducer(state, { kind: "permission", prompt });

    state = conversationReducer(state, {
      kind: "hydrate",
      segments: [
        { type: "text", id: "u1", role: "user", content: "create a pdf" },
      ],
    });

    expect(state.pendingPermission).toBe(prompt);
  });

  it("leaves a sub-agent still running when the turn is live", () => {
    let state = createInitialConversationState();
    state = conversationReducer(state, { kind: "permission", prompt });

    state = conversationReducer(state, {
      kind: "hydrate",
      segments: [
        { type: "text", id: "u1", role: "user", content: "create a ppt" },
        {
          type: "subtask",
          id: "deck-1",
          status: "created",
          description: "Component",
        } as never,
      ],
    });

    const card = state.segments.find((segment) => segment.type === "subtask");
    expect(card?.type === "subtask" && card.subtaskStatus).toBe("running");
  });

  it("settles an unclosed sub-agent as interrupted in a finished chat", () => {
    const state = conversationReducer(createInitialConversationState(), {
      kind: "hydrate",
      segments: [
        {
          type: "subtask",
          id: "deck-1",
          status: "created",
          description: "Component",
        } as never,
      ],
    });

    const card = state.segments.find((segment) => segment.type === "subtask");
    expect(card?.type === "subtask" && card.subtaskStatus).toBe("interrupted");
  });
});
