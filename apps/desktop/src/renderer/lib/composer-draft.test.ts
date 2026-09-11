import { beforeEach, describe, expect, it } from "vitest";

import {
  composerDraftForKeyChange,
  composerDraftKey,
  readComposerDraft,
  writeComposerDraft,
} from "./composer-draft";

beforeEach(() => window.localStorage.clear());

describe("composer drafts", () => {
  it("stores a separate draft for each workspace", () => {
    writeComposerDraft("one", "first");
    writeComposerDraft("two", "second");

    expect(readComposerDraft("one")).toBe("first");
    expect(readComposerDraft("two")).toBe("second");
  });

  it("removes empty drafts", () => {
    writeComposerDraft("one", "draft");
    writeComposerDraft("one", "");

    expect(window.localStorage.getItem(composerDraftKey("one"))).toBeNull();
  });
});

/**
 * Typing a prompt and then choosing the folder.
 *
 * A new session pane starts with no workspace selected, so the box has no key
 * and nowhere to persist what is typed. Picking the folder gives it one, and
 * the text used to be dropped on the way — the prompt vanished exactly when
 * the user was ready to send it.
 */
describe("carrying a draft across a change of identity", () => {
  const move = (
    previousKey: string | null,
    nextKey: string | null,
    current: string
  ): ReturnType<typeof composerDraftForKeyChange> =>
    composerDraftForKeyChange({
      previousKey,
      nextKey,
      current,
      read: readComposerDraft,
    });

  it("keeps text typed before any folder was chosen", () => {
    const result = move(null, "workspace:w1", "summarise this repo");

    expect(result.value).toBe("summarise this repo");
    expect(result.writes).toEqual([["workspace:w1", "summarise this repo"]]);
  });

  it("keeps text when the folder is changed for another one", () => {
    writeComposerDraft("workspace:w1", "summarise this repo");

    const result = move("workspace:w1", "workspace:w2", "summarise this repo");

    expect(result.value).toBe("summarise this repo");
    // The old box is emptied, or the text would come back the next time that
    // workspace's new-session box is opened.
    expect(result.writes).toEqual([
      ["workspace:w1", ""],
      ["workspace:w2", "summarise this repo"],
    ]);
  });

  /**
   * The reciprocal, and the reason the carry is not unconditional: one box
   * used to be shared across sessions, so text meant for one chat was sitting
   * in another when it was opened.
   */
  it("does not follow the user out of a session into a new-session box", () => {
    const result = move("session:s1", "workspace:w1", "half a thought");

    expect(result.value).toBe("");
    expect(result.writes).toEqual([]);
  });

  it("does not follow the user between two sessions", () => {
    const result = move("session:s1", "session:s2", "half a thought");

    expect(result.value).toBe("");
    expect(result.writes).toEqual([]);
  });

  it("prefers what that box already holds over what is carried", () => {
    writeComposerDraft("workspace:w2", "its own draft");

    const result = move("workspace:w1", "workspace:w2", "carried text");

    expect(result.value).toBe("its own draft");
    expect(result.writes).toEqual([]);
  });

  it("restores a session's own draft when it is reopened", () => {
    writeComposerDraft("session:s1", "where I left off");

    const result = move("workspace:w1", "session:s1", "");

    expect(result.value).toBe("where I left off");
  });

  it("empties the box when there is no identity to show", () => {
    const result = move("workspace:w1", null, "typed");

    expect(result.value).toBe("");
    expect(result.writes).toEqual([]);
  });

  it("carries nothing on a first mount, where there is nothing typed", () => {
    const result = move(null, "workspace:w1", "");

    expect(result.value).toBe("");
    expect(result.writes).toEqual([]);
  });
});
