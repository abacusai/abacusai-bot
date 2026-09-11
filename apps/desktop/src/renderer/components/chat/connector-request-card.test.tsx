/**
 * The Connect button the agent is waiting on.
 *
 * Its turn is suspended inside the tool call while this is on screen, so every
 * path out of the card has to answer — connecting, declining, or a hop that
 * fails. A card that could be left unanswered would hang the agent.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { act, type JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: Record<string, unknown>) => void;

const listeners: Listener[] = [];
/** What was called, in the order it was called — the point of one test below. */
const calls: string[] = [];
const connectAbacusConnector = vi.fn(async () => {
  calls.push("connect");
  return { ok: true } as const;
});
const respondConnector = vi.fn(async (_request: unknown) => {
  calls.push("respond");
  return undefined;
});
const refreshMcpServers = vi.fn(async () => {
  calls.push("refresh");
  return { success: true };
});
const cancelAbacusConnector = vi.fn(async () => {
  calls.push("cancel");
});
let pendingRequests: Array<Record<string, unknown>> = [];
const listConnectorRequests = vi.fn(async () => pendingRequests);
const markSessionCompleted = vi.fn();

/** The conversation on screen, as the card reads it. */
const activeKey = vi.hoisted(() => ({ current: null as string | null }));

vi.mock("../../stores/active-conversation-store", () => ({
  useActiveConversationKey: () => activeKey.current,
}));

vi.mock("../../stores/code-store", () => {
  const state = {
    activeWorkspaceId: "ws-1",
    getActiveSessionId: () => "sess-1",
    markSessionCompleted: (id: string) => markSessionCompleted(id),
  };
  const useWorkspaceStore = (select: (s: typeof state) => unknown) =>
    select(state);
  useWorkspaceStore.getState = () => state;
  return { useWorkspaceStore };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values?.provider != null ? `${key}:${values.provider}` : key,
  }),
}));

const { ConnectorRequestCard } = await import("./connector-request-card");
const { sessionConversationKey } = await import("#shared/conversation-scope");

const here = sessionConversationKey("ws-1", "sess-1");
const elsewhere = sessionConversationKey("bots", "bot-telegram");

const byId = (id: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(`[data-id="${id}"]`);
  if (node == null) throw new Error(`no element with data-id="${id}"`);

  return node;
};

/** The agent asking, as the renderer hears it. */
const ask = (): void => {
  act(() => {
    for (const listener of listeners)
      listener({
        type: "connector-request",
        request: {
          requestId: "req-1",
          service: "slack",
          label: "Slack",
          reason: "to read #general",
          conversationKey: here,
        },
      });
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  listeners.length = 0;
  pendingRequests = [];
  activeKey.current = here;
  (globalThis.window as unknown as { api: unknown }).api = {
    agent: {
      onEvent: (listener: Listener) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
      connectAbacusConnector,
      respondConnector,
      refreshMcpServers,
      cancelAbacusConnector,
      listConnectorRequests,
    },
  };
  render((<ConnectorRequestCard />) as JSX.Element);
});

describe("the connector request card", () => {
  it("picks a still-pending ask back up after a remount", async () => {
    // The field case: the agent asked, the user visited another page, and
    // the Connect button was gone for good on return while the agent stayed
    // suspended. The queue is component state; a fresh mount re-fetches it.
    cleanup();
    pendingRequests = [
      {
        requestId: "req-9",
        service: "whatsapp",
        label: "WhatsApp",
        conversationKey: here,
      },
    ];
    render((<ConnectorRequestCard />) as JSX.Element);

    await waitFor(() =>
      expect(
        document.querySelector('[data-id="connector-request"]')
      ).not.toBeNull()
    );
    expect(byId("connector-request").dataset.service).toBe("whatsapp");
  });

  it("does not duplicate an ask that arrives twice", async () => {
    cleanup();
    pendingRequests = [
      {
        requestId: "req-1",
        service: "slack",
        label: "Slack",
        conversationKey: here,
      },
    ];
    render((<ConnectorRequestCard />) as JSX.Element);
    await waitFor(() => expect(listConnectorRequests).toHaveBeenCalled());
    ask();

    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-id="connector-request"]')
      ).toHaveLength(1)
    );
  });

  it("stays out of the way until the agent asks", () => {
    expect(document.querySelector('[data-id="connector-request"]')).toBeNull();
  });

  it("names the service and says why, in the agent's words", () => {
    ask();

    expect(byId("connector-request").dataset.service).toBe("slack");
    expect(byId("connector-request").textContent).toContain("to read #general");
    expect(byId("connector-request-connect").textContent).toContain("Slack");
  });

  it("runs the hop and reports the connection", async () => {
    ask();

    fireEvent.click(byId("connector-request-connect"));

    await waitFor(() =>
      expect(connectAbacusConnector).toHaveBeenCalledWith("slack")
    );
    await waitFor(() =>
      expect(respondConnector).toHaveBeenCalledWith({
        requestId: "req-1",
        conversationKey: here,
        outcome: "connected",
      })
    );
    expect(document.querySelector('[data-id="connector-request"]')).toBeNull();
  });

  /**
   * The session already running is holding the tool list it started with, so
   * the connector's tools are not in it until it reloads — and the agent is
   * suspended inside the tool call, with a tool call as its very next act. A
   * refresh started after the answer is a race it loses, which is how a fresh
   * connect was followed by "Tool ... not found" and a guessed tool name.
   */
  it("reloads the running session's tools before it lets the agent go", async () => {
    ask();

    fireEvent.click(byId("connector-request-connect"));

    await waitFor(() => expect(respondConnector).toHaveBeenCalled());
    expect(refreshMcpServers).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      sessionId: "sess-1",
    });
    expect(calls).toEqual(["connect", "refresh", "respond"]);
  });

  it("does not reload anything when the hop was declined", async () => {
    ask();

    fireEvent.click(byId("connector-request-decline"));

    await waitFor(() => expect(respondConnector).toHaveBeenCalled());
    expect(refreshMcpServers).not.toHaveBeenCalled();
  });

  it("answers when declined rather than leaving the agent hanging", async () => {
    ask();

    fireEvent.click(byId("connector-request-decline"));

    await waitFor(() =>
      expect(respondConnector).toHaveBeenCalledWith({
        requestId: "req-1",
        conversationKey: here,
        outcome: "declined",
      })
    );
    expect(connectAbacusConnector).not.toHaveBeenCalled();
  });

  it("keeps Not now alive mid-hop, and it cancels the browser wait", async () => {
    // The field case: Connect clicked, mind changed in the browser, back to
    // a card that was all spinner — no way out until the timeout. Declining
    // mid-hop cancels the wait; the cancelled resolution answers the agent.
    let release: (value: { ok: false; cancelled: true }) => void = () => {};
    connectAbacusConnector.mockReturnValue(
      new Promise((resolve) => {
        release = resolve as typeof release;
      }) as never
    );
    ask();
    fireEvent.click(byId("connector-request-connect"));
    await waitFor(() =>
      expect(connectAbacusConnector).toHaveBeenCalledWith("slack")
    );

    const decline = byId("connector-request-decline");
    expect(decline.hasAttribute("disabled")).toBe(false);
    fireEvent.click(decline);
    await waitFor(() => expect(cancelAbacusConnector).toHaveBeenCalled());
    // Only the cancel — the answer comes from the hop resolving cancelled,
    // never from the decline click too (that would answer the agent twice).
    expect(respondConnector).not.toHaveBeenCalled();

    release({ ok: false, cancelled: true });
    await waitFor(() =>
      expect(respondConnector).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "declined" })
      )
    );
    expect(respondConnector).toHaveBeenCalledTimes(1);
  });

  it("reads a cancelled browser hop as declining, not as a failure", async () => {
    connectAbacusConnector.mockResolvedValue({
      ok: false,
      cancelled: true,
    } as never);
    ask();

    fireEvent.click(byId("connector-request-connect"));

    await waitFor(() =>
      expect(respondConnector).toHaveBeenCalledWith({
        requestId: "req-1",
        conversationKey: here,
        outcome: "declined",
      })
    );
  });

  it("keeps the card up when the hop fails, so it can be tried again", async () => {
    connectAbacusConnector.mockResolvedValue({
      ok: false,
      error: "Slack said no",
    } as never);
    ask();

    fireEvent.click(byId("connector-request-connect"));

    await waitFor(() =>
      expect(byId("connector-request-error").textContent).toBe("Slack said no")
    );
    expect(respondConnector).not.toHaveBeenCalled();
    expect(byId("connector-request-connect")).toBeTruthy();
  });

  it("takes the card down when the agent's turn ends without it", () => {
    ask();

    act(() => {
      for (const listener of listeners)
        listener({ type: "connector-cleared", requestId: "req-1" });
    });

    expect(document.querySelector('[data-id="connector-request"]')).toBeNull();
  });
});

/**
 * The card shows an ask only in the conversation that made it. There is no
 * "show it wherever the user is" any more: that fallback, plus an app-wide
 * pending list, is how a bot's Telegram button landed in a plain session.
 */
describe("which conversation the card belongs to", () => {
  const askFrom = (conversationKey: string): void => {
    act(() => {
      for (const listener of listeners)
        listener({
          type: "connector-request",
          request: {
            requestId: "req-scoped",
            service: "telegram",
            label: "Telegram",
            conversationKey,
          },
        });
    });
  };

  const showing = (): boolean =>
    document.querySelector('[data-id="connector-request"]') != null;

  /** Replaces the shared card from beforeEach with one in a named conversation. */
  const inConversation = (conversationKey: string | null): void => {
    cleanup();
    activeKey.current = conversationKey;
    render((<ConnectorRequestCard />) as JSX.Element);
  };

  it("shows the button in the conversation that asked", () => {
    inConversation(elsewhere);
    askFrom(elsewhere);

    expect(showing()).toBe(true);
  });

  it("keeps it out of every other conversation, and flags the one it is for", () => {
    inConversation(here);
    askFrom(elsewhere);

    expect(showing()).toBe(false);
    expect(markSessionCompleted).toHaveBeenCalledWith("bot-telegram");
  });

  it("shows nothing where no conversation is open", () => {
    // The new-chat pane used to show every pending ask in the app.
    inConversation(null);
    askFrom(elsewhere);

    expect(showing()).toBe(false);
  });

  it("asks main only for its own conversation's pending asks", async () => {
    inConversation(here);

    await waitFor(() =>
      expect(listConnectorRequests).toHaveBeenCalledWith(here)
    );
  });

  it("answers with the conversation the ask was filed under", async () => {
    inConversation(elsewhere);
    askFrom(elsewhere);
    fireEvent.click(byId("connector-request-decline"));

    await waitFor(() => expect(respondConnector).toHaveBeenCalled());
    expect(respondConnector.mock.calls[0]?.[0]).toMatchObject({
      requestId: "req-scoped",
      conversationKey: elsewhere,
      outcome: "declined",
    });
  });
});
