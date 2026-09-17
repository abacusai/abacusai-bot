import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  draftConversationKey,
  sessionConversationKey,
} from "#shared/conversation-scope";

import {
  terminalRuntimeActions,
  terminalRuntimeStore,
  useTerminalRuntimeScope,
} from "./terminal-runtime-store";

afterEach(() => terminalRuntimeActions.reset());

describe("terminal runtime renderer state", () => {
  it("keeps visibility and generation separate for each conversation", () => {
    const first = sessionConversationKey("workspace", "first");
    const second = sessionConversationKey("workspace", "second");
    const { result, rerender } = renderHook(
      ({ scope }) => useTerminalRuntimeScope(scope),
      { initialProps: { scope: first } }
    );

    act(() => {
      terminalRuntimeActions.setOpen(first, true);
      terminalRuntimeActions.setGeneration(first, 3);
    });
    expect(result.current).toMatchObject({
      isOpen: true,
      generation: 3,
      activeTabId: "terminal-1",
    });
    expect(result.current.tabs).toEqual([
      { id: "terminal-1", label: "Terminal 1", generation: 3 },
    ]);

    rerender({ scope: second });
    expect(result.current).toMatchObject({
      isOpen: false,
      generation: null,
      tabs: [],
      activeTabId: null,
    });
  });

  it("moves draft state to the saved conversation", () => {
    const draft = draftConversationKey("workspace");
    const session = sessionConversationKey("workspace", "saved");
    act(() => {
      terminalRuntimeActions.setOpen(draft, true);
      terminalRuntimeActions.setGeneration(draft, 2);
      terminalRuntimeActions.promoteDraft(draft, session);
    });

    expect(useTerminalRuntimeScope).toBeTypeOf("function");
    expect(terminalRuntimeStore.get().scopes[session]).toMatchObject({
      isOpen: true,
      generation: null,
      activeTabId: "terminal-1",
    });
    expect(terminalRuntimeStore.get().scopes[draft]).toBeUndefined();
  });

  it("disposes one scope or every scope in a workspace", () => {
    const first = sessionConversationKey("workspace-one", "first");
    const second = sessionConversationKey("workspace-one", "second");
    const other = sessionConversationKey("workspace-two", "other");
    act(() => {
      terminalRuntimeActions.setOpen(first, true);
      terminalRuntimeActions.setOpen(second, true);
      terminalRuntimeActions.setOpen(other, true);
      terminalRuntimeActions.disposeScope(first);
    });
    expect(terminalRuntimeStore.get().scopes[first]).toBeUndefined();

    act(() => terminalRuntimeActions.disposeWorkspace("workspace-one"));
    expect(terminalRuntimeStore.get().scopes[other]).toMatchObject({
      isOpen: true,
      generation: null,
    });
    expect(Object.keys(terminalRuntimeStore.get().scopes)).toEqual([other]);
  });

  it("adds, selects, and closes independent terminal tabs", () => {
    const scope = sessionConversationKey("workspace", "session");
    let second = "";
    act(() => {
      terminalRuntimeActions.setOpen(scope, true);
      terminalRuntimeActions.setGeneration(scope, 1);
      second = terminalRuntimeActions.addTab(scope);
      terminalRuntimeActions.setGeneration(scope, 2, second);
    });

    expect(terminalRuntimeStore.get().scopes[scope]).toMatchObject({
      activeTabId: second,
      generation: 2,
    });
    expect(terminalRuntimeStore.get().scopes[scope]?.tabs).toHaveLength(2);

    act(() => terminalRuntimeActions.closeTab(scope, second));
    expect(terminalRuntimeStore.get().scopes[scope]).toMatchObject({
      activeTabId: "terminal-1",
      generation: 1,
    });
  });

  it("carries a picked shell on its own tab and leaves the rest to main", () => {
    const scope = sessionConversationKey("workspace", "session");
    let picked = "";
    act(() => {
      terminalRuntimeActions.setOpen(scope, true);
      picked = terminalRuntimeActions.addTab(scope, {
        shell: "busybox",
        label: "BusyBox sh",
      });
    });

    const tabs = terminalRuntimeStore.get().scopes[scope]?.tabs ?? [];

    // The default tab asks for nothing: main opens whatever is stored.
    expect(tabs[0]?.id).toBe("terminal-1");
    expect(tabs[0]?.shell).toBeUndefined();
    expect(tabs[1]).toMatchObject({
      id: picked,
      label: "BusyBox sh",
      shell: "busybox",
    });

    // What was actually spawned is written back, so a restart asks again for
    // the same shell rather than the current preference.
    act(() =>
      terminalRuntimeActions.setTabShell(scope, "terminal-1", "powershell")
    );
    expect(terminalRuntimeStore.get().scopes[scope]?.tabs[0]?.shell).toBe(
      "powershell"
    );
  });
});
