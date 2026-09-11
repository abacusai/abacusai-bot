/**
 * Where an agent's deliverable lands.
 *
 * `present_deliverable` names the conversation it came from. The item goes to
 * THAT pane; the pane only comes forward when that conversation is on screen,
 * and a chat that is not on screen gets the sidebar dot instead. An event with
 * no key (an older main) falls back to the chat on screen.
 */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IpcEvent } from "#shared/contracts";
import { sessionConversationKey } from "#shared/conversation-scope";

import { setActiveConversationKey } from "../stores/active-conversation-store";
import {
  previewActions,
  previewStore,
  selectPreviewScope,
} from "../stores/preview-store";

const setActiveRightTab = vi.fn();
const setRightPanelVisible = vi.fn();
const markSessionCompleted = vi.fn();

vi.mock("../stores/code-store", () => ({
  useWorkspaceStore: {
    getState: () => ({
      setActiveRightTab,
      setRightPanelVisible,
      markSessionCompleted,
    }),
  },
}));

let listener: ((event: IpcEvent) => void) | null = null;

const onScreen = sessionConversationKey("workspace-1", "on-screen");
const elsewhere = sessionConversationKey("workspace-1", "elsewhere");

const emit = (event: Partial<IpcEvent> & { type: "preview-open" }): void => {
  listener?.({ emittedAt: "now", ...event } as IpcEvent);
};

beforeEach(() => {
  previewActions.reset();
  setActiveConversationKey(onScreen);
  setActiveRightTab.mockClear();
  setRightPanelVisible.mockClear();
  markSessionCompleted.mockClear();
  listener = null;
  Object.assign(window, {
    api: {
      agent: {
        onEvent: (next: (event: IpcEvent) => void) => {
          listener = next;
          return () => {
            listener = null;
          };
        },
      },
      files: { readFileAsText: vi.fn() },
    },
  });
});

describe("the preview-open bridge", () => {
  it("opens the pane when the deliverable is for the chat on screen", async () => {
    const { usePreviewOpenBridge } = await import("./preview-utils");
    renderHook(() => usePreviewOpenBridge());

    emit({
      type: "preview-open",
      path: "http://localhost:5173",
      conversationKey: onScreen,
    });

    expect(selectPreviewScope(previewStore.state, onScreen).items).toHaveLength(
      1
    );
    expect(setActiveRightTab).toHaveBeenCalledWith("preview");
    expect(setRightPanelVisible).toHaveBeenCalledWith(true);
    expect(markSessionCompleted).not.toHaveBeenCalled();
  });

  it("files a background chat's deliverable in that chat and leaves the pane alone", async () => {
    const { usePreviewOpenBridge } = await import("./preview-utils");
    renderHook(() => usePreviewOpenBridge());

    emit({
      type: "preview-open",
      path: "http://localhost:5173",
      conversationKey: elsewhere,
    });

    expect(
      selectPreviewScope(previewStore.state, elsewhere).items
    ).toHaveLength(1);
    expect(selectPreviewScope(previewStore.state, onScreen).items).toHaveLength(
      0
    );
    expect(setActiveRightTab).not.toHaveBeenCalled();
    expect(setRightPanelVisible).not.toHaveBeenCalled();
    expect(markSessionCompleted).toHaveBeenCalledWith("elsewhere");
  });

  it("falls back to the chat on screen for an event with no key", async () => {
    const { usePreviewOpenBridge } = await import("./preview-utils");
    renderHook(() => usePreviewOpenBridge());

    emit({ type: "preview-open", path: "http://localhost:5173" });

    expect(selectPreviewScope(previewStore.state, onScreen).items).toHaveLength(
      1
    );
    expect(setActiveRightTab).toHaveBeenCalledWith("preview");
  });
});
