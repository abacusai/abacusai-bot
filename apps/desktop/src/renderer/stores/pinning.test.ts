/**
 * Pinning, which the two sidebar sections do separately.
 *
 * Bots and Sessions are two lists with two Pinned groups, so they keep two
 * lists of ids. Pinning in one must never move anything in the other.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { useWorkspaceStore } from "./code-store";

const state = () => useWorkspaceStore.getState();

beforeEach(() => {
  useWorkspaceStore.setState({ pinnedSessionIds: [], pinnedBotIds: [] });
});

describe("pinning a bot", () => {
  it("is a toggle, not a one-way door", () => {
    state().toggleBotPinned("bot-1");
    expect(state().isBotPinned("bot-1")).toBe(true);

    state().toggleBotPinned("bot-1");
    expect(state().isBotPinned("bot-1")).toBe(false);
  });

  it("keeps the order they were pinned in", () => {
    state().toggleBotPinned("bot-1");
    state().toggleBotPinned("bot-2");

    expect(state().pinnedBotIds).toEqual(["bot-1", "bot-2"]);
  });

  it("leaves the others alone when one is unpinned", () => {
    state().toggleBotPinned("bot-1");
    state().toggleBotPinned("bot-2");
    state().toggleBotPinned("bot-1");

    expect(state().pinnedBotIds).toEqual(["bot-2"]);
  });
});

describe("the two lists", () => {
  it("do not touch each other", () => {
    state().toggleBotPinned("shared-id");

    expect(state().isBotPinned("shared-id")).toBe(true);
    expect(state().isSessionPinned("shared-id")).toBe(false);
  });

  it("can hold the same id independently", () => {
    // Bot ids and session ids do not overlap today, so this is a guard on the
    // separation itself rather than a case anyone can reach.
    state().toggleBotPinned("shared-id");
    state().toggleSessionPinned("shared-id");
    state().toggleBotPinned("shared-id");

    expect(state().isBotPinned("shared-id")).toBe(false);
    expect(state().isSessionPinned("shared-id")).toBe(true);
  });
});
