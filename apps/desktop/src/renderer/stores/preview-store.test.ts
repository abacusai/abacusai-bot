import { beforeEach, describe, expect, it } from "vitest";

import {
  draftConversationKey,
  sessionConversationKey,
  type ConversationKey,
} from "#shared/conversation-scope";

import {
  previewActions,
  previewStore,
  previewTabId,
  selectPreviewItem,
  selectPreviewScope,
  type PreviewItem,
} from "./preview-store";

const sessionA = sessionConversationKey("workspace-1", "session-a");
const sessionB = sessionConversationKey("workspace-1", "session-b");
const elsewhere = sessionConversationKey("workspace-2", "session-c");

// Typed as the store's own scope, not the session default's narrower type:
// a draft chat holds previews too, and the promote test hands one in.
const scopeState = (scope: ConversationKey = sessionA) =>
  selectPreviewScope(previewStore.state, scope);

const open = (item: PreviewItem, scope: ConversationKey = sessionA) =>
  previewActions.open(scope, item);

beforeEach(() => {
  previewActions.reset();
});

describe("preview tab identity", () => {
  it("keeps browser resources at the same URL as separate tabs", () => {
    open({
      type: "url",
      location: "https://example.com",
      title: "Browser one",
      resourceId: "browser:one",
    });
    open({
      type: "url",
      location: "https://example.com",
      title: "Browser two",
      resourceId: "browser:two",
    });

    const state = scopeState();
    expect(state.items).toHaveLength(2);
    expect(state.items.map(previewTabId)).toEqual([
      "browser:one",
      "browser:two",
    ]);
  });

  it("refreshes an existing browser resource by id, in place", () => {
    open({
      type: "url",
      location: "https://example.com",
      title: "Browser one",
      resourceId: "browser:one",
    });
    open({
      type: "url",
      location: "https://example.com",
      title: "Browser two",
      resourceId: "browser:two",
    });
    const firstOpenedAt = scopeState().items[0]?.openedAt;

    const { id } = open({
      type: "url",
      location: "https://example.com/refreshed",
      title: "Browser one refreshed",
      resourceId: "browser:one",
    });

    const state = scopeState();
    expect(id).toBe("browser:one");
    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({
      location: "https://example.com/refreshed",
      title: "Browser one refreshed",
      resourceId: "browser:one",
    });
    expect(state.items[0]?.openedAt).toBeGreaterThan(firstOpenedAt ?? 0);
    expect(state.items[1]?.resourceId).toBe("browser:two");
  });

  it("dedupes files by type and location when callers supply no id", () => {
    open({
      type: "file",
      location: "src/app.ts",
      title: "app.ts",
      fileContent: "old",
    });
    open({ type: "url", location: "https://example.com", title: "Browser" });
    open({
      type: "file",
      location: "src/app.ts",
      title: "app.ts",
      fileContent: "fresh",
    });

    const state = scopeState();
    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({
      type: "file",
      location: "src/app.ts",
      fileContent: "fresh",
    });
    expect(state.items[1]?.type).toBe("url");
  });

  it("keeps the source/rendered choice across a re-open", () => {
    open({ type: "md", location: "/a.md", title: "a", showSource: true });

    open({ type: "md", location: "/a.md", title: "a" });

    expect(scopeState().items[0]?.showSource).toBe(true);
  });

  it("finds an item by its tab id", () => {
    const { id } = open({ type: "md", location: "/a.md", title: "a" });

    expect(selectPreviewItem(previewStore.state, sessionA, id)).toMatchObject({
      title: "a",
    });
    expect(selectPreviewItem(previewStore.state, sessionA, "other")).toBeNull();
    expect(selectPreviewItem(previewStore.state, sessionA, null)).toBeNull();
  });
});

describe("one pane per conversation", () => {
  it("keeps a file opened in one chat out of every other chat", () => {
    open({ type: "md", location: "/tmp/report.md", title: "report.md" });

    expect(scopeState(sessionA).items).toHaveLength(1);
    expect(scopeState(sessionB).items).toHaveLength(0);
  });

  it("lets each chat close its own tabs", () => {
    const { id } = open({ type: "md", location: "/a/one.md", title: "one" });
    open({ type: "md", location: "/a/two.md", title: "two" });
    open({ type: "md", location: "/b/only.md", title: "only" }, sessionB);

    previewActions.close(sessionA, id);
    expect(scopeState(sessionA).items.map(({ title }) => title)).toEqual([
      "two",
    ]);
    expect(scopeState(sessionB).items.map(({ title }) => title)).toEqual([
      "only",
    ]);
  });

  it("ignores a close for a tab another chat holds", () => {
    const { id } = open({ type: "md", location: "/a/one.md", title: "one" });

    previewActions.close(sessionB, id);

    expect(scopeState(sessionA).items).toHaveLength(1);
    expect(scopeState(sessionB).items).toHaveLength(0);
  });

  it("caps the tabs per chat, not across the app, and names what fell off", () => {
    let dropped: string[] = [];
    for (let index = 0; index < 52; index++) {
      dropped = open({
        type: "md",
        location: `/a/${index}.md`,
        title: `${index}`,
      }).dropped;
    }
    open({ type: "md", location: "/b/only.md", title: "only" }, sessionB);

    expect(scopeState(sessionA).items).toHaveLength(50);
    expect(scopeState(sessionA).items[0]?.title).toBe("2");
    expect(dropped).toEqual([
      previewTabId({ type: "md", location: "/a/1.md" }),
    ]);
    expect(scopeState(sessionB).items).toHaveLength(1);
  });

  it("carries a new chat's previews into the session it becomes", () => {
    const draft = draftConversationKey("workspace-1");
    open({ type: "md", location: "/draft.md", title: "draft" }, draft);

    previewActions.promoteDraft(draft, sessionA);

    expect(scopeState(draft).items).toHaveLength(0);
    expect(scopeState(sessionA).items.map(({ title }) => title)).toEqual([
      "draft",
    ]);
  });

  it("releases one chat, or one workspace, without touching the rest", () => {
    open({ type: "md", location: "/a.md", title: "a" }, sessionA);
    open({ type: "md", location: "/b.md", title: "b" }, sessionB);
    open({ type: "md", location: "/c.md", title: "c" }, elsewhere);

    previewActions.disposeScope(sessionA);
    expect(previewStore.state.scopes[sessionA]).toBeUndefined();
    expect(scopeState(sessionB).items).toHaveLength(1);

    previewActions.disposeWorkspace("workspace-1");
    expect(previewStore.state.scopes[sessionB]).toBeUndefined();
    expect(scopeState(elsewhere).items).toHaveLength(1);
  });
});
