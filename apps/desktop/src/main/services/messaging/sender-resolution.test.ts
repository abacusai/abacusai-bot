/**
 * Name → sender resolution for auto-reply.
 *
 * The stakes are higher than list_chats lookups: a resolved sender gets the
 * user's account answering them automatically. So exact beats substring, and
 * ambiguity is an answer, never a guess.
 */
import { describe, expect, it } from "vitest";

import { resolveSender, type SenderCandidate } from "./sender-resolution";

const row = (
  name: string,
  userId: string,
  platform: SenderCandidate["platform"] = "whatsapp"
): SenderCandidate => ({ platform, userId, chatId: userId, name });

describe("resolving a sender by name", () => {
  it("finds a unique substring match, case-insensitively", () => {
    const result = resolveSender(
      [row("Alex Fischer", "1"), row("Mom", "2")],
      "alex"
    );

    expect(result).toEqual({
      kind: "match",
      candidate: row("Alex Fischer", "1"),
    });
  });

  it("prefers an exact name over substring hits", () => {
    const result = resolveSender(
      [row("Mo", "1"), row("Mom", "2"), row("Mohan", "3")],
      "mo"
    );

    expect(result).toEqual({ kind: "match", candidate: row("Mo", "1") });
  });

  it("resolves an id as itself", () => {
    const result = resolveSender(
      [row("Alex", "491701234@c.us")],
      "491701234@c.us"
    );

    expect(result.kind).toBe("match");
  });

  it("reports ambiguity instead of guessing", () => {
    const result = resolveSender(
      [row("Alex Fischer", "1"), row("Alexandra", "2")],
      "alex"
    );

    expect(result.kind).toBe("ambiguous");
  });

  it("reports nobody rather than a stretch", () => {
    expect(resolveSender([row("Mom", "1")], "boss")).toEqual({ kind: "none" });
    expect(resolveSender([row("Mom", "1")], "  ")).toEqual({ kind: "none" });
  });

  it("lets a later row override an earlier one for the same sender", () => {
    // Callers put the pairing store last: its userId came from a real inbound
    // message, which beats an address book's guess for the same person.
    const result = resolveSender(
      [row("491701234", "1"), row("Alex", "1")],
      "alex"
    );

    expect(result).toEqual({ kind: "match", candidate: row("Alex", "1") });
  });
});
