/**
 * What a bot's sidebar row says under its name.
 *
 * The row used to carry the bot's role label, which never changes and so never
 * told anyone anything. The last thing said is why you would open the chat.
 */
import { describe, expect, it } from "vitest";

import type { TranscriptService } from "../session/transcript-service";
import { botChatPreview } from "./bot-chat-preview";

const transcripts = (segments: unknown[]): TranscriptService =>
  ({
    read: () => ({
      version: 1 as const,
      sessionId: "s1",
      updatedAt: "",
      segments,
    }),
  }) as unknown as TranscriptService;

const empty = { read: () => null } as unknown as TranscriptService;

describe("the line under the name", () => {
  it("is the last message, not the first", () => {
    const preview = botChatPreview(
      transcripts([
        { type: "text", content: "Hello", at: 1 },
        { type: "text", content: "Want me to add the Gmail connector?", at: 2 },
      ]),
      "s1"
    );

    expect(preview?.text).toBe("Want me to add the Gmail connector?");
    expect(preview?.at).toBe(2);
  });

  it("is the last LINE of it, which is where the question is", () => {
    // A closing question is the thing the user has to answer; the opening
    // sentence is throat-clearing.
    const preview = botChatPreview(
      transcripts([
        { type: "text", content: "Looked at three.\n\nShall I open a PR?" },
      ]),
      "s1"
    );

    expect(preview?.text).toBe("Shall I open a PR?");
  });

  it("skips markdown scaffolding rather than showing a bullet", () => {
    const preview = botChatPreview(
      transcripts([{ type: "text", content: "Done:\n- one\n- two" }]),
      "s1"
    );

    expect(preview?.text).toBe("two");
  });

  it("looks past segments that are not messages", () => {
    const preview = botChatPreview(
      transcripts([
        { type: "text", content: "On it." },
        { type: "tool_group", summary: "Read 3 files" },
        { type: "notification", message: "Routed." },
      ]),
      "s1"
    );

    expect(preview?.text).toBe("On it.");
  });

  it("looks past a message with nothing in it", () => {
    const preview = botChatPreview(
      transcripts([
        { type: "text", content: "The real one." },
        { type: "text", content: "   \n\n" },
      ]),
      "s1"
    );

    expect(preview?.text).toBe("The real one.");
  });

  it("truncates rather than handing the row an essay", () => {
    const preview = botChatPreview(
      transcripts([{ type: "text", content: "x".repeat(5000) }]),
      "s1"
    );

    expect(preview?.text.length).toBe(200);
  });

  it("says nothing for a bot whose chat has never been opened", () => {
    expect(botChatPreview(transcripts([]), null)).toBeNull();
  });

  it("says nothing when there is no transcript on disk", () => {
    expect(botChatPreview(empty, "s1")).toBeNull();
  });

  it("says nothing when the chat exists but nobody has spoken", () => {
    expect(
      botChatPreview(transcripts([{ type: "tool_group" }]), "s1")
    ).toBeNull();
  });

  it("reports no time for a transcript written before times were kept", () => {
    const preview = botChatPreview(
      transcripts([{ type: "text", content: "Old message" }]),
      "s1"
    );

    expect(preview?.text).toBe("Old message");
    expect(preview?.at).toBeNull();
  });
});
