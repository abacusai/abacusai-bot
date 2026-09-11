/**
 * The per-turn cache line, and the one warning that matters: cached tokens
 * falling to zero after they had been hitting.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { describeAgentEvent, resetCacheWatch } from "./agent-event-log";

const turn = (
  sessionId: string,
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    requests?: number;
    model?: string | null;
  }
): string | null =>
  describeAgentEvent(sessionId, {
    type: "event",
    event: {
      type: "turn_complete",
      usage: { requests: 1, model: null, ...usage },
    },
  } as never);

describe("the cache line", () => {
  beforeEach(() => resetCacheWatch());

  it("says what the provider charged, per turn", () => {
    expect(
      turn("s1", { input: 300, output: 40, cacheRead: 9000, cacheWrite: 0 })
    ).toMatch(/cache read 9000 write 0 input 300 output 40/);
  });

  it("flags cached tokens dropping to zero after hits", () => {
    turn("s1", { input: 300, output: 40, cacheRead: 9000, cacheWrite: 0 });
    expect(
      turn("s1", { input: 9300, output: 40, cacheRead: 0, cacheWrite: 9300 })
    ).toMatch(/PROMPT CACHE MISS after hits/);
  });

  it("does not flag the first request of a session, nor a tiny one", () => {
    expect(
      turn("s2", { input: 9300, output: 40, cacheRead: 0, cacheWrite: 9300 })
    ).not.toMatch(/MISS/);
    turn("s2", { input: 300, output: 40, cacheRead: 9000, cacheWrite: 0 });
    expect(
      turn("s2", { input: 200, output: 10, cacheRead: 0, cacheWrite: 0 })
    ).not.toMatch(/MISS/);
  });

  it("keeps sessions apart", () => {
    turn("a", { input: 300, output: 40, cacheRead: 9000, cacheWrite: 0 });
    expect(
      turn("b", { input: 9300, output: 40, cacheRead: 0, cacheWrite: 9300 })
    ).not.toMatch(/MISS/);
  });
});
