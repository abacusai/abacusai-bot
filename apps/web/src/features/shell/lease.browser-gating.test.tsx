import { afterEach, expect, it, vi } from "vitest";
const callApps = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("./connect/services", () => ({
  callApps,
  browserConnection: () => ({ deploymentConversationId: "conversation" }),
}));
import { installLease, markActivity } from "./lease";
afterEach(() => vi.useRealTimers());
it("renews only a visible connected tab with recent activity", async () => {
  vi.useFakeTimers();
  const visible = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  let connected = true;
  const stop = installLease(() => connected);
  try {
    markActivity();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callApps).toHaveBeenCalledExactlyOnceWith("keepAliveAbacusBotHost", {
      deploymentConversationId: "conversation",
    });
    connected = false;
    await vi.advanceTimersByTimeAsync(60_000);
    connected = true;
    visible.mockReturnValue("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    visible.mockReturnValue("visible");
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(callApps).toHaveBeenCalledTimes(2);
  } finally {
    stop();
  }
});
