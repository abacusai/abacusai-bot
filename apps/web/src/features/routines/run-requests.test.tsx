import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { RunRequests } from "./run-requests";
const mocks = vi.hoisted(() => ({
  respond: vi.fn(async () => {}),
  refresh: vi.fn(),
}));
const context = {
  transport: {
    client: {
      connectors: { respond: mocks.respond },
      mcp: { refresh: mocks.refresh },
    },
  },
};
vi.mock("#renderer/lib/use-app-context", async (original) => ({
  ...(await original<typeof import("#renderer/lib/use-app-context")>()),
  useAppContext: () => context,
}));
vi.mock("#renderer/data/queries/notices", async () => {
  const { sessionConversationKey } =
    await import("@abacus-ai/contract/conversation-scope");
  const snapshot = {
    type: "snapshot",
    requests: [
      {
        requestId: "ask",
        connectorId: "test",
        conversationKey: sessionConversationKey("w", "s"),
      },
      {
        requestId: "other",
        connectorId: "test",
        conversationKey: sessionConversationKey("w", "other"),
      },
    ],
  };
  return {
    noticeSnapshot: () => ({ subscribe: () => () => {}, get: () => snapshot }),
  };
});
vi.mock("#renderer/components/connector-request-card", () => ({
  ConnectorRequestCard: ({ onConnect }: { onConnect(): void }) => (
    <button onClick={() => onConnect()}>Connect</button>
  ),
}));
it("calls a connect that landed connected, whether or not the run is still there to refresh", async () => {
  mocks.respond.mockClear();
  mocks.refresh.mockResolvedValue({
    success: false,
    error: "CLI session is not running.",
  });
  const view = render(
    <RunRequests
      sessionIds={new Set(["s"])}
      connect={async () => ({ ok: true as const })}
      cancel={async () => {}}
    />
  );
  try {
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(mocks.respond).toHaveBeenCalledExactlyOnceWith({
        requestId: "ask",
        conversationKey: sessionConversationKey("w", "s"),
        outcome: "connected",
      })
    );
  } finally {
    view.unmount();
  }
});
it.each(["hop", "throw"])(
  "settles a failed %s as a failed tool response",
  async (stage) => {
    mocks.respond.mockClear();
    mocks.refresh.mockResolvedValue({ success: true });
    const connect = vi.fn(async () => {
      if (stage === "throw") throw new Error("hop threw");
      return stage === "hop"
        ? { ok: false as const, error: "hop failed" }
        : { ok: true as const };
    });
    const view = render(
      <RunRequests
        sessionIds={new Set(["s"])}
        connect={connect}
        cancel={async () => {}}
      />
    );
    try {
      // Only the asks of the given runs.
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
      await waitFor(() =>
        expect(mocks.respond).toHaveBeenCalledExactlyOnceWith({
          requestId: "ask",
          conversationKey: sessionConversationKey("w", "s"),
          outcome: "failed",
          error: stage === "throw" ? "hop threw" : `${stage} failed`,
        })
      );
    } finally {
      view.unmount();
    }
  }
);
