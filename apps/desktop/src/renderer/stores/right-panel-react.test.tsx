import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  browserResourceActions,
  browserResourceStore,
  createBrowserResourceState,
  selectBrowserResource,
} from "./browser-resource-store";
import {
  conversationScopeActions,
  dispatchRightPanel,
  rightPanelActions,
  rightPanelStore,
  useRightPanelScope,
  useRightPanelScopeSelector,
} from "./right-panel-react";
import {
  createResourceRightPanelDescriptor,
  createRightPanelState,
  createSingletonRightPanelDescriptor,
  draftConversationKey,
  rightPanelScopeKey,
  sessionConversationKey,
} from "./right-panel-store";
import {
  terminalRuntimeActions,
  terminalRuntimeStore,
} from "./terminal-runtime-store";

const firstScope = rightPanelScopeKey({
  workspaceId: "workspace-one",
  sessionId: "session-one",
});
const secondScope = rightPanelScopeKey({
  workspaceId: "workspace-two",
  sessionId: "session-two",
});

beforeEach(() => {
  rightPanelStore.setState(() => createRightPanelState());
  browserResourceStore.setState(() => createBrowserResourceState());
  terminalRuntimeActions.reset();
});

describe("right panel React adapter", () => {
  it("dispatches narrowly typed actions through the core reducer", () => {
    const files = createSingletonRightPanelDescriptor("files", "Files");
    const browser = createResourceRightPanelDescriptor({
      resourceType: "browser",
      resourceKey: "profile/tab",
      title: "Browser",
    });

    act(() => {
      rightPanelActions.focus(firstScope, files);
      rightPanelActions.focus(firstScope, browser);
      rightPanelActions.closeActive(firstScope);
    });

    const state = rightPanelStore.get().scopes[firstScope]!;
    expect(state.descriptors).toEqual([files]);
    expect(state.activeId).toBe("files");
    expect(state.isOpen).toBe(true);

    act(() => rightPanelActions.closeActive(firstScope));
    expect(rightPanelStore.get().scopes[firstScope]).toMatchObject({
      descriptors: [],
      activeId: null,
      isOpen: true,
    });

    act(() => rightPanelActions.hide(firstScope));
    expect(rightPanelStore.get().scopes[firstScope]?.isOpen).toBe(false);

    act(() => rightPanelActions.show(firstScope));
    expect(rightPanelStore.get().scopes[firstScope]?.isOpen).toBe(true);
  });

  it("exposes the general dispatch boundary for reducer actions", () => {
    act(() => {
      dispatchRightPanel({
        type: "set-agents-availability",
        scope: firstScope,
        availability: { available: false, reason: "No active run" },
      });
    });

    expect(
      rightPanelStore.get().scopes[firstScope]?.agentsAvailability
    ).toEqual({ available: false, reason: "No active run" });
  });

  it("selects one scope without rerendering for changes in another scope", () => {
    let renders = 0;
    const hook = renderHook(() => {
      renders += 1;
      return useRightPanelScopeSelector(firstScope, (state) => state.activeId);
    });
    const initialRenders = renders;

    act(() => {
      rightPanelActions.focus(
        secondScope,
        createSingletonRightPanelDescriptor("files", "Files")
      );
    });
    expect(renders).toBe(initialRenders);
    expect(hook.result.current).toBeNull();

    act(() => {
      rightPanelActions.focus(
        firstScope,
        createSingletonRightPanelDescriptor("files", "Files")
      );
    });
    expect(renders).toBe(initialRenders + 1);
    expect(hook.result.current).toBe("files");
  });

  it("returns a stable empty scope until that scope is materialized", () => {
    let renders = 0;
    const hook = renderHook(() => {
      renders += 1;
      return useRightPanelScope(firstScope);
    });
    const emptyScope = hook.result.current;
    const initialRenders = renders;

    act(() => {
      rightPanelActions.focus(
        secondScope,
        createSingletonRightPanelDescriptor("files", "Files")
      );
    });

    expect(renders).toBe(initialRenders);
    expect(hook.result.current).toBe(emptyScope);
  });

  it("coordinates promotion and disposal across panel and browser state", () => {
    const draft = draftConversationKey("workspace-one");
    const session = sessionConversationKey("workspace-one", "saved-session");
    const browserId = browserResourceActions.create(draft);
    const descriptor = createResourceRightPanelDescriptor({
      id: browserId,
      resourceType: "browser",
      resourceKey: browserId,
      title: "Browser",
    });
    rightPanelActions.focus(draft, descriptor);
    terminalRuntimeActions.setOpen(draft, true);
    terminalRuntimeActions.setGeneration(draft, 4);

    act(() => conversationScopeActions.promoteDraft(draft, session));

    expect(rightPanelStore.get().scopes[draft]).toBeUndefined();
    expect(rightPanelStore.get().scopes[session]?.activeId).toBe(browserId);
    expect(
      selectBrowserResource(browserResourceStore.get(), session, browserId)
    ).toMatchObject({ id: browserId, scope: session });
    expect(terminalRuntimeStore.get().scopes[session]).toMatchObject({
      isOpen: true,
      generation: null,
      // Ids are minted per terminal and never reused, so the promoted tab is
      // read rather than named.
      activeTabId: terminalRuntimeStore.get().scopes[session]?.tabs[0]?.id,
    });

    act(() => conversationScopeActions.disposeWorkspace("workspace-one"));
    expect(rightPanelStore.get().scopes[session]).toBeUndefined();
    expect(browserResourceStore.get().scopes[session]).toBeUndefined();
    expect(terminalRuntimeStore.get().scopes[session]).toBeUndefined();
  });
});
