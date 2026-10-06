import { expect, it, vi } from "vitest";

import { AgentCommunicationService } from "./cli-communication-service";

it("carries operator tags on the send command with the original prompt", () => {
  const dispatch = vi.fn(() => true);
  const communication = new AgentCommunicationService(dispatch);
  const message = "operator rules\n\n[Ada] hello";
  const userText = {
    operator: { kind: "auto-reply-intro" as const, visibleFrom: 16 },
  };
  expect(
    communication.sendMessage({
      workspaceId: "w",
      sessionId: "s",
      message,
      userText,
    })
  ).toBe(true);
  expect(dispatch).toHaveBeenCalledWith(
    "w",
    "s",
    expect.objectContaining({ type: "send", message, userText })
  );
});
