import { expect, it, vi } from "vitest";

import { openCommandReceiver } from "./open-target";
it("replay retries failed acknowledgement without repeating committed navigation", async () => {
  const navigate = vi.fn(async () => {});
  const ack = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(undefined);
  const receive = openCommandReceiver({
    navigate,
    ack,
    signal: new AbortController().signal,
  });
  const command = {
    id: "a",
    at: 0,
    target: { kind: "session" as const, sessionId: "s" },
  };
  await expect(receive(command)).rejects.toThrow("offline");
  await receive(command);
  await receive(command);
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(ack).toHaveBeenCalledTimes(2);
});
