import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { sessionConversationKey } from "#shared/conversation-scope";

import { RunRequests } from "./run-requests";
const mocks = vi.hoisted(() => ({
  respond: vi.fn(async () => {}),
  refresh: vi.fn(),
}));
const context = {
  transport: {
    client: {
      connectors: { respond: mocks.respond, events: () => {} },
      mcp: { refresh: mocks.refresh },
    },
  },
};
vi.mock("#next/lib/use-app-context", async (original) => ({
  ...(await original<typeof import("#next/lib/use-app-context")>()),
  useAppContext: () => context,
}));
vi.mock("#next/data/queries/live", () => ({
  followNotices: (
    _t: unknown,
    _open: unknown,
    onEvent: (event: unknown) => void
  ) => {
    onEvent({
      type: "snapshot",
      requests: [
        { requestId: "ask", connectorId: "test", conversationKey: "test" },
      ],
    });
  },
}));
vi.mock("#next/components/connector-request-card", () => ({
  ConnectorRequestCard: ({ onConnect }: { onConnect(): void }) => (
    <button onClick={() => onConnect()}>Connect</button>
  ),
}));
it.each(["hop", "refresh", "throw"])(
  "settles a failed %s as a failed tool response",
  async (stage) => {
    mocks.respond.mockClear();
    mocks.refresh.mockResolvedValue(
      stage === "refresh"
        ? { success: false, error: "refresh failed" }
        : { success: true }
    );
    const connect = vi.fn(async () => {
      if (stage === "throw") throw new Error("hop threw");
      return stage === "hop"
        ? { ok: false as const, error: "hop failed" }
        : { ok: true as const };
    });
    const view = render(
      <RunRequests
        sessionId="s"
        workspaceId="w"
        connect={connect}
        cancel={async () => {}}
      />
    );
    try {
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
