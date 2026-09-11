/**
 * The permission prompt shows for the conversation on screen, and no other.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: Record<string, unknown>) => void;

const listeners: Listener[] = [];
const respondBrowserPermission = vi.fn(async (_request: unknown) => undefined);
let pending: Array<Record<string, unknown>> = [];
const listBrowserPermissionRequests = vi.fn(async () => pending);
const markSessionCompleted = vi.fn();
const activeKey = vi.hoisted(() => ({ current: null as string | null }));

vi.mock("../../stores/active-conversation-store", () => ({
  useActiveConversationKey: () => activeKey.current,
}));
vi.mock("../../stores/code-store", () => ({
  useWorkspaceStore: {
    getState: () => ({ markSessionCompleted }),
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { BrowserPermissionPrompt } = await import("./browser-permission-prompt");
const { sessionConversationKey } = await import("#shared/conversation-scope");

const here = sessionConversationKey("ws-1", "sess-1");
const elsewhere = sessionConversationKey("ws-1", "sess-2");

const showing = (): boolean =>
  document.querySelector('[data-id="browser-permission-prompt"]') != null;

const askFrom = (conversationKey: string): void => {
  act(() => {
    for (const listener of listeners)
      listener({
        type: "browser-permission-request",
        request: {
          requestId: "perm-1",
          tool: "device_tap",
          summary: "Tap Home",
          server: "device",
          conversationKey,
        },
      });
  });
};

const mountIn = (conversationKey: string | null): void => {
  cleanup();
  activeKey.current = conversationKey;
  render((<BrowserPermissionPrompt />) as JSX.Element);
};

beforeEach(() => {
  vi.clearAllMocks();
  listeners.length = 0;
  pending = [];
  (globalThis.window as unknown as { api: unknown }).api = {
    agent: {
      onEvent: (listener: Listener) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
      respondBrowserPermission,
      listBrowserPermissionRequests,
    },
  };
});

describe("which conversation a permission prompt belongs to", () => {
  it("shows in the conversation whose turn is waiting", () => {
    mountIn(here);
    askFrom(here);

    expect(showing()).toBe(true);
  });

  it("stays out of every other conversation, and flags the right one", () => {
    mountIn(here);
    askFrom(elsewhere);

    expect(showing()).toBe(false);
    expect(markSessionCompleted).toHaveBeenCalledWith("sess-2");
  });

  it("shows nothing where no conversation is open", () => {
    mountIn(null);
    askFrom(elsewhere);

    expect(showing()).toBe(false);
  });

  it("picks its own conversation's prompt back up on mount", async () => {
    pending = [
      {
        requestId: "perm-9",
        tool: "device_tap",
        summary: "Tap Home",
        server: "device",
        conversationKey: here,
      },
    ];
    mountIn(here);

    await waitFor(() => expect(showing()).toBe(true));
    expect(listBrowserPermissionRequests).toHaveBeenCalledWith(here);
  });

  it("answers with the conversation the prompt was filed under", async () => {
    mountIn(here);
    askFrom(here);
    fireEvent.click(
      document.querySelector(
        '[data-id="browser-permission-deny"]'
      ) as HTMLElement
    );

    await waitFor(() => expect(respondBrowserPermission).toHaveBeenCalled());
    expect(respondBrowserPermission.mock.calls[0]?.[0]).toMatchObject({
      requestId: "perm-1",
      conversationKey: here,
      decision: "deny",
    });
    expect(showing()).toBe(false);
  });
});
