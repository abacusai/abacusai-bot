/** Which note a mid-run message gets, by chat: the desktop's own, a chat app's, a sender's. */
import { fakePi } from "@abacus-ai/test-support/fake-pi";
import { describe, expect, it } from "vitest";

import {
  MidRunMessages,
  midRunMessageNote,
  type MidRunMessagesOptions,
} from "./mid-run-message.js";

const asked = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
});

const contextAfter = async (
  options: MidRunMessagesOptions,
  steer: (messages: MidRunMessages) => void
) => {
  const messages = new MidRunMessages(options);
  const pi = fakePi();
  messages.extension(pi.api as never);
  steer(messages);
  const result = (await pi.fire("context", {
    messages: [asked("build it"), asked("is it nearly done?")],
  })) as { messages?: Array<{ content: Array<{ text: string }> }> } | undefined;
  return result?.messages?.at(-1)?.content[0]?.text ?? null;
};

describe("a message sent mid-run", () => {
  it("is answered in the chat itself on the desktop", async () => {
    expect(await contextAfter({}, (m) => m.note("is it nearly done?"))).toBe(
      midRunMessageNote()
    );
  });

  it("is answered with the chat app's progress tool where the line only reaches the user through it", async () => {
    const note = await contextAfter(
      { progressTools: () => ["send_progress", "send_media"] },
      (m) => m.note("is it nearly done?")
    );
    expect(note).toContain("with send_progress");
  });

  it("gets no note where a mid-run line reaches no one", async () => {
    expect(
      await contextAfter({ unheard: () => true }, (m) =>
        m.note("is it nearly done?")
      )
    ).toBeNull();
  });

  it("gets no note once cleared: dropped from the run, or a new turn began", async () => {
    expect(
      await contextAfter({}, (m) => {
        m.note("is it nearly done?");
        m.clear();
      })
    ).toBeNull();
  });

  it("tells the model a request to stop ends the work", () => {
    expect(midRunMessageNote()).toContain(
      "If they ask you to stop or cancel, do not carry on"
    );
  });
});
