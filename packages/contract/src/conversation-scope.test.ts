import { describe, expect, it } from "vitest";

import {
  conversationBelongsToWorkspace,
  conversationKey,
  conversationRefFromKey,
  draftConversationKey,
  draftConversationRef,
  sessionConversationKey,
  sessionConversationRef,
} from "./conversation-scope";

describe("conversation scope contract", () => {
  it("keeps two drafts in one workspace separate from each other and a saved session", () => {
    const first = draftConversationKey("workspace", "draft-one");
    const second = draftConversationKey("workspace", "draft-two");
    expect(first).not.toBe(second);
    expect(first).not.toBe(sessionConversationKey("workspace", "draft-one"));
    expect(conversationRefFromKey(first)).toEqual(
      draftConversationRef("workspace", "draft-one")
    );
    expect(conversationBelongsToWorkspace(first, "workspace")).toBe(true);
    expect(conversationRefFromKey(draftConversationKey("workspace"))).toEqual(
      draftConversationRef("workspace")
    );
  });
  it("round-trips draft and saved-session identities", () => {
    const draft = draftConversationRef(" workspace-one ");
    const session = sessionConversationRef("workspace-one", " session-one ");

    expect(conversationRefFromKey(conversationKey(draft))).toEqual(draft);
    expect(conversationRefFromKey(conversationKey(session))).toEqual(session);
    expect(draftConversationKey("workspace-one")).not.toBe(
      sessionConversationKey("workspace-one", "session-one")
    );
  });

  it("rejects malformed, empty, and cross-workspace identities", () => {
    expect(() => draftConversationKey(" ")).toThrow(TypeError);
    expect(() => sessionConversationKey("workspace-one", " ")).toThrow(
      TypeError
    );
    expect(
      conversationRefFromKey(
        '["conversation",2,"workspace-one","draft"]' as never
      )
    ).toBeNull();
    expect(
      conversationBelongsToWorkspace(
        sessionConversationKey("workspace-one", "session-one"),
        "workspace-two"
      )
    ).toBe(false);
  });
});
