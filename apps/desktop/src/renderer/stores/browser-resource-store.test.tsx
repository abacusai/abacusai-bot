import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  browserResourceActions,
  browserResourceStore,
  createBrowserResourceState,
  selectBrowserResource,
  selectBrowserResourceScope,
  useBrowserResource,
  useBrowserResources,
} from "./browser-resource-store";
import {
  draftConversationKey,
  rightPanelScopeKey,
  sessionConversationKey,
} from "./right-panel-store";

const firstScope = rightPanelScopeKey({
  workspaceId: "workspace-one",
  sessionId: "session-one",
});
const secondScope = rightPanelScopeKey({
  workspaceId: "workspace-two",
  sessionId: "session-two",
});

beforeEach(() => {
  browserResourceStore.setState(() => createBrowserResourceState());
});

describe("browser resource store", () => {
  it("creates a real browser resource before it has a URL", () => {
    const id = browserResourceActions.create(firstScope);
    const state = browserResourceStore.get();

    expect(selectBrowserResourceScope(state, firstScope).resourceIds).toEqual([
      id,
    ]);
    expect(selectBrowserResource(state, firstScope, id)).toEqual({
      id,
      scope: firstScope,
      url: null,
      title: "Browser",
      profileId: null,
      navigation: {
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
      },
    });
  });

  it("keeps multiple browser resources at the same URL", () => {
    const first = browserResourceActions.create(firstScope, {
      url: "https://example.com",
    });
    const second = browserResourceActions.create(firstScope, {
      url: "https://example.com",
    });

    expect(first).not.toBe(second);
    expect(
      selectBrowserResourceScope(browserResourceStore.get(), firstScope)
        .resourceIds
    ).toEqual([first, second]);
    expect(
      selectBrowserResource(browserResourceStore.get(), firstScope, first)
    ).toMatchObject({ url: "https://example.com" });
    expect(
      selectBrowserResource(browserResourceStore.get(), firstScope, second)
    ).toMatchObject({ url: "https://example.com" });
  });

  it("updates URL, title, profile, and navigation without changing identity", () => {
    const id = browserResourceActions.create(firstScope);

    browserResourceActions.setLocation(
      firstScope,
      id,
      "http://localhost:3000",
      "Local app"
    );
    browserResourceActions.setProfile(firstScope, id, "chrome-work");
    browserResourceActions.setNavigation(firstScope, id, {
      canGoBack: true,
      isLoading: true,
    });
    browserResourceActions.setTitle(firstScope, id, "Local app");

    expect(
      selectBrowserResource(browserResourceStore.get(), firstScope, id)
    ).toEqual({
      id,
      scope: firstScope,
      url: "http://localhost:3000",
      title: "Local app",
      profileId: "chrome-work",
      navigation: {
        canGoBack: true,
        canGoForward: false,
        isLoading: true,
      },
    });
  });

  it("returns to the URL-less chooser state without replacing the resource", () => {
    const id = browserResourceActions.create(firstScope, {
      url: "https://example.com",
      title: "Example",
    });

    browserResourceActions.update(firstScope, id, { url: null, title: " " });

    expect(
      selectBrowserResource(browserResourceStore.get(), firstScope, id)
    ).toMatchObject({ id, url: null, title: "Browser" });
  });

  it("does not mutate a browser through the wrong scope", () => {
    const id = browserResourceActions.create(firstScope);
    const before = browserResourceStore.get();

    browserResourceActions.setLocation(
      secondScope,
      id,
      "https://wrong.example"
    );

    expect(browserResourceStore.get()).toBe(before);
    expect(
      selectBrowserResource(browserResourceStore.get(), firstScope, id)
    ).toMatchObject({ url: null });
  });

  it("disposes one resource and removes an empty scope", () => {
    const first = browserResourceActions.create(firstScope);
    const second = browserResourceActions.create(firstScope);

    browserResourceActions.dispose(firstScope, first);
    expect(
      selectBrowserResourceScope(browserResourceStore.get(), firstScope)
        .resourceIds
    ).toEqual([second]);

    browserResourceActions.dispose(firstScope, second);
    expect(browserResourceStore.get().scopes[firstScope]).toBeUndefined();
  });

  it("disposes every browser in one scope without touching another", () => {
    browserResourceActions.create(firstScope);
    const second = browserResourceActions.create(secondScope);

    browserResourceActions.disposeScope(firstScope);

    expect(browserResourceStore.get().scopes[firstScope]).toBeUndefined();
    expect(
      selectBrowserResourceScope(browserResourceStore.get(), secondScope)
        .resourceIds
    ).toEqual([second]);
  });

  it("rekeys draft resources into a saved session without changing IDs", () => {
    const draft = draftConversationKey("workspace-one");
    const session = sessionConversationKey("workspace-one", "saved-session");
    const draftId = browserResourceActions.create(draft, {
      url: "https://draft.example",
    });
    const savedId = browserResourceActions.create(session, {
      url: "https://saved.example",
    });

    browserResourceActions.promoteDraft(draft, session);

    expect(browserResourceStore.get().scopes[draft]).toBeUndefined();
    expect(
      selectBrowserResourceScope(browserResourceStore.get(), session)
        .resourceIds
    ).toEqual([draftId, savedId]);
    expect(
      selectBrowserResource(browserResourceStore.get(), session, draftId)
    ).toMatchObject({ id: draftId, scope: session });
    expect(
      selectBrowserResource(browserResourceStore.get(), session, savedId)
    ).toMatchObject({ id: savedId, scope: session });

    const once = browserResourceStore.get();
    browserResourceActions.promoteDraft(draft, session);
    expect(browserResourceStore.get()).toBe(once);
  });

  it("disposes all browser resources for one workspace", () => {
    const draft = draftConversationKey("workspace-one");
    const session = sessionConversationKey("workspace-one", "saved-session");
    const other = sessionConversationKey("workspace-two", "other-session");
    browserResourceActions.create(draft);
    browserResourceActions.create(session);
    const otherId = browserResourceActions.create(other);

    browserResourceActions.disposeWorkspace("workspace-one");

    expect(browserResourceStore.get().scopes[draft]).toBeUndefined();
    expect(browserResourceStore.get().scopes[session]).toBeUndefined();
    expect(
      selectBrowserResourceScope(browserResourceStore.get(), other).resourceIds
    ).toEqual([otherId]);
  });

  it("keeps React selectors scoped and resource-specific", () => {
    const first = browserResourceActions.create(firstScope);
    const second = browserResourceActions.create(secondScope);
    let resourceRenders = 0;
    let listRenders = 0;

    const resourceHook = renderHook(() => {
      resourceRenders += 1;
      return useBrowserResource(firstScope, first);
    });
    const listHook = renderHook(() => {
      listRenders += 1;
      return useBrowserResources(firstScope);
    });
    const initialResourceRenders = resourceRenders;
    const initialListRenders = listRenders;

    act(() => {
      browserResourceActions.setTitle(secondScope, second, "Other browser");
    });

    expect(resourceRenders).toBe(initialResourceRenders);
    expect(listRenders).toBe(initialListRenders);

    act(() => {
      browserResourceActions.setTitle(firstScope, first, "First browser");
    });

    expect(resourceHook.result.current?.title).toBe("First browser");
    expect(listHook.result.current[0]?.title).toBe("First browser");
  });
});

describe("adopting a browser the agent created", () => {
  it("adds the resource under main's id, so the surface attaches to the same view", () => {
    browserResourceActions.adopt(firstScope, "agent-browser", "https://a.test");
    const state = browserResourceStore.get();

    expect(selectBrowserResourceScope(state, firstScope).resourceIds).toEqual([
      "agent-browser",
    ]);
    expect(
      selectBrowserResource(state, firstScope, "agent-browser" as never)
    ).toMatchObject({ id: "agent-browser", url: "https://a.test" });
  });

  it("only updates the URL when it is already known", () => {
    browserResourceActions.adopt(firstScope, "agent-browser", "https://a.test");
    browserResourceActions.adopt(firstScope, "agent-browser", "https://b.test");
    const state = browserResourceStore.get();

    expect(selectBrowserResourceScope(state, firstScope).resourceIds).toEqual([
      "agent-browser",
    ]);
    expect(
      selectBrowserResource(state, firstScope, "agent-browser" as never)?.url
    ).toBe("https://b.test");
  });
});
