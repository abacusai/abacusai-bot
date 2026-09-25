/**
 * The Connect button the agent is waiting on.
 *
 * Its turn is suspended inside the tool call while this is on screen, so every
 * path out of the card has to answer: connecting, declining, or a hop that
 * fails. A card that could be left unanswered would hang the agent. And it
 * connects any registry connector the same way the Connectors page does: a
 * platform hop, a token dialog for GitHub, a pairing dialog for a chat app.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { act, type JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: Record<string, unknown>) => void;

const listeners: Listener[] = [];
/** What was called, in the order it was called: the point of one test below. */
const calls: string[] = [];
const connectConnector = vi.fn(async (_id: string) => {
  calls.push("connect");
  return { ok: true } as const;
});
const submitConnectorFields = vi.fn(
  async (_id: string, _values: Record<string, string>) => {
    calls.push("submit");
    return { ok: true } as const;
  }
);
const listConnectorStatuses = vi.fn(async () => ({}));
const respondConnector = vi.fn(async (_request: unknown) => {
  calls.push("respond");
  return undefined;
});
const refreshMcpServers = vi.fn(async () => {
  calls.push("refresh");
  return { success: true };
});
const cancelConnectorConnect = vi.fn(async () => {
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
      values?.provider != null
        ? `${key}:${values.provider}`
        : values?.name != null
          ? `${key}:${values.name}`
          : key,
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
const ask = (
  connectorId = "abacus-slack",
  label = "Slack",
  conversationKey = here
): void => {
  act(() => {
    for (const listener of listeners)
      listener({
        type: "connector-request",
        request: {
          requestId: "req-1",
          connectorId,
          label,
          reason: "to read #general",
          conversationKey,
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
    openExternal: vi.fn(),
    agent: {
      onEvent: (listener: Listener) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
      connectConnector,
      submitConnectorFields,
      listConnectorStatuses,
      respondConnector,
      refreshMcpServers,
      cancelConnectorConnect,
      listConnectorRequests,
      getMessagingSnapshot: async () => null,
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
        connectorId: "messaging-whatsapp",
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
    expect(byId("connector-request").dataset.connector).toBe(
      "messaging-whatsapp"
    );
  });

  it("does not duplicate an ask that arrives twice", async () => {
    cleanup();
    pendingRequests = [
      {
        requestId: "req-1",
        connectorId: "abacus-slack",
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

    expect(byId("connector-request").dataset.connector).toBe("abacus-slack");
    expect(byId("connector-request").textContent).toContain("to read #general");
    expect(byId("connector-request-connect").textContent).toContain("Slack");
  });

  it("runs the hop and reports the connection", async () => {
    ask();

    fireEvent.click(byId("connector-request-connect"));

    await waitFor(() =>
      expect(connectConnector).toHaveBeenCalledWith("abacus-slack")
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
   * the connector's tools are not in it until it reloads, and the agent is
   * suspended inside the tool call, with a tool call as its very next act. A
   * refresh started after the answer is a race it loses, which is how a fresh
   * connect was followed by "Tool ... not found" and a guessed tool name.
   */
  it("installs a tool server straight from the chat, no dialog in between", async () => {
    ask("playwright", "Playwright");

    fireEvent.click(byId("connector-request-connect"));

    await waitFor(() =>
      expect(connectConnector).toHaveBeenCalledWith("playwright")
    );
    await waitFor(() =>
      expect(respondConnector).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "req-1", outcome: "connected" })
      )
    );
  });

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

  /**
   * The GitHub card takes a token, and the agent asking for GitHub used to
   * get nothing to click. Now the same dialog the Connectors page shows opens
   * in the chat, and submitting it resolves the tool call.
   */
  it("opens the token dialog in the chat for a credential connector, and answers on submit", async () => {
    ask("github", "GitHub");

    fireEvent.click(byId("connector-request-connect"));

    await waitFor(() => byId("connector-credential-prompt"));
    expect(connectConnector).not.toHaveBeenCalled();
    expect(byId("connector-credential-setup").textContent).toContain(
      "github.com/settings/tokens"
    );

    fireEvent.change(byId("connector-credential-GH_TOKEN"), {
      target: { value: "ghp_secret" },
    });
    fireEvent.click(byId("connector-credential-submit"));

    await waitFor(() =>
      expect(submitConnectorFields).toHaveBeenCalledWith("github", {
        GH_TOKEN: "ghp_secret",
      })
    );
    await waitFor(() =>
      expect(respondConnector).toHaveBeenCalledWith({
        requestId: "req-1",
        conversationKey: here,
        outcome: "connected",
      })
    );
    expect(calls).toEqual(["submit", "refresh", "respond"]);
  });

  it("reads a closed token dialog as declining, not as a failure", async () => {
    ask("github", "GitHub");
    fireEvent.click(byId("connector-request-connect"));
    await waitFor(() => byId("connector-credential-prompt"));

    fireEvent.click(byId("connector-credential-cancel"));

    await waitFor(() =>
      expect(respondConnector).toHaveBeenCalledWith({
        requestId: "req-1",
        conversationKey: here,
        outcome: "declined",
      })
    );
    expect(submitConnectorFields).not.toHaveBeenCalled();
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
    expect(connectConnector).not.toHaveBeenCalled();
  });

  it("keeps Not now alive mid-hop, and it cancels the browser wait", async () => {
    // The field case: Connect clicked, mind changed in the browser, back to
    // a card that was all spinner with no way out until the timeout. Declining
    // mid-hop cancels the wait; the cancelled resolution answers the agent.
    let release: (value: { ok: false; cancelled: true }) => void = () => {};
    connectConnector.mockReturnValue(
      new Promise((resolve) => {
        release = resolve as typeof release;
      }) as never
    );
    ask();
    fireEvent.click(byId("connector-request-connect"));
    await waitFor(() =>
      expect(connectConnector).toHaveBeenCalledWith("abacus-slack")
    );

    const decline = byId("connector-request-decline");
    expect(decline.hasAttribute("disabled")).toBe(false);
    fireEvent.click(decline);
    await waitFor(() => expect(cancelConnectorConnect).toHaveBeenCalled());
    // Only the cancel. The answer comes from the hop resolving cancelled,
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
    connectConnector.mockResolvedValue({
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
    connectConnector.mockResolvedValue({
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
            connectorId: "messaging-telegram",
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
