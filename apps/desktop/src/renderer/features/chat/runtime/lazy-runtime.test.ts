import { describe, expect, it, vi } from "vitest";

import type { AiClient } from "#renderer/data/ai";

import { createLazyChatRuntime } from "./lazy-runtime";
import * as runtimeModule from "./runtime";

describe("companion chat runtime demand", () => {
  it("loads once before presenting a thread and shares concurrent preparation", async () => {
    const load = vi.fn(async () => runtimeModule);
    const { chat, prepareChat } = createLazyChatRuntime(
      {} as AiClient,
      { maxSessions: 2 },
      load
    );
    expect(load).not.toHaveBeenCalled();
    chat.forget("absent");
    expect(load).not.toHaveBeenCalled();
    expect(() => chat.session("thread")).toThrow(/must be prepared/);
    const first = prepareChat();
    expect(prepareChat()).toBe(first);
    await first;
    const session = chat.session("thread");
    expect(chat.session("thread")).toBe(session);
    expect(load).toHaveBeenCalledTimes(1);
    chat.forget("thread");
    expect(session.retired).toBe(true);
  });

  it("retries a failed module load without leaving preparation stuck", async () => {
    const load = vi
      .fn<() => Promise<typeof runtimeModule>>()
      .mockRejectedValueOnce(new Error("load failed"))
      .mockResolvedValue(runtimeModule);
    const { chat, prepareChat } = createLazyChatRuntime(
      {} as AiClient,
      {},
      load
    );
    await expect(prepareChat()).rejects.toThrow("load failed");
    await prepareChat();
    expect(chat.session("thread").retired).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
    chat.forget("thread");
  });
});
