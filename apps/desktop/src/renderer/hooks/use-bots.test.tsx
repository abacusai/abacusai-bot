import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useBotOwnedSessionIds } from "./use-bots";

const listBots = vi.fn();
const listBotSenderChats = vi.fn();

const wrapperFor = (client: QueryClient) =>
  function QueryWrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };

beforeEach(() => {
  listBots.mockResolvedValue([
    { id: "bot-1", name: "forslack", sessionId: "forever-1" },
    // A bot whose forever chat has never been opened.
    { id: "bot-2", name: "quiet", sessionId: null },
  ]);
  listBotSenderChats.mockResolvedValue([
    {
      botId: "bot-1",
      workspaceId: "ws-1",
      sessionId: "routine-1",
      platform: "routine",
      senderName: "OnSlack",
    },
    {
      botId: "bot-1",
      workspaceId: "ws-1",
      sessionId: "sender-1",
      platform: "whatsapp",
      senderName: "Pranshu",
    },
  ]);
  (window as unknown as { api: unknown }).api = {
    agent: { listBots, listBotSenderChats },
  };
});

describe("useBotOwnedSessionIds", () => {
  it("covers routine and sender chats, not just the forever chat", async () => {
    const { result } = renderHook(() => useBotOwnedSessionIds(), {
      wrapper: wrapperFor(new QueryClient()),
    });

    await waitFor(() => expect(result.current.size).toBe(3));
    expect([...result.current].sort()).toEqual([
      "forever-1",
      "routine-1",
      "sender-1",
    ]);
  });

  it("is empty before either list has loaded", () => {
    const { result } = renderHook(() => useBotOwnedSessionIds(), {
      wrapper: wrapperFor(new QueryClient()),
    });

    expect(result.current.size).toBe(0);
  });
});
