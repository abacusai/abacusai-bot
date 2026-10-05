import { expect, it, vi } from "vitest";

import { createChatRuntime } from "#next/features/chat";
import * as b from "#next/features/chat/fixtures/builders";
import { FakeRelay } from "#next/features/chat/fixtures/relay";

import { NotchDirector } from "./director";
import type { NotchPresentation } from "./presenter";
const presentation = (id: string, next?: string): NotchPresentation => {
  const attention = (sessionId: string) => ({
    kind: "approval" as const,
    sessionId,
    descriptorId: sessionId,
    since: 0,
    botId: null,
  });
  return {
    route: "/approval/$id",
    sessionId: id,
    identity: id,
    attention: attention(id),
    queue: [attention(id), ...(next ? [attention(next)] : [])],
    faces: [],
    remaining: next ? 1 : 0,
    expanded: true,
    hidden: false,
    quietUntil: null,
  };
};
it("R6-T19 the production director bounds real relay subscriptions through changes, cancellation and disposal", async () => {
  const relay = new FakeRelay();
  relay.emitAll(b.sessionReady());
  const runtime = createChatRuntime(relay.ai, { maxSessions: 2 });
  const retire = vi.fn((id: string) => runtime.session(id).retire());
  const director = new NotchDirector({
    load: (id, signal) => runtime.session(id).load({ signal }),
    retire,
    setShape: async () => {},
    navigate: async () => {},
    settle: async () => {},
    renderedSize: () => ({ width: 200, height: 32 }),
    audio: () => false,
    commit: () => {},
  });
  let peak = 0;
  try {
    for (let index = 0; index < 20; index++) {
      await director.present(
        presentation(`thread-${index}`, `thread-${index + 1}`),
        { width: 200, height: 200 }
      );
      await vi.waitFor(() => expect(relay.stats.openIterators).toBe(2));
      peak = Math.max(peak, relay.stats.openIterators);
    }
    // Retirement must be done by the director even with runtime cache eviction.
    expect(retire).toHaveBeenCalledWith("thread-0");
    const stale = director.present(presentation("cancelled"), {
      width: 200,
      height: 200,
    });
    await director.present(
      {
        ...presentation("calm"),
        route: "/idle",
        sessionId: null,
        identity: "calm",
        expanded: false,
        attention: null,
        queue: [],
      },
      { width: 200, height: 32 }
    );
    await stale;
    await vi.waitFor(() => expect(relay.stats.openIterators).toBe(0));
    await director.present(presentation("final", "standby"), {
      width: 200,
      height: 200,
    });
    await vi.waitFor(() => expect(relay.stats.openIterators).toBe(2));
    expect(peak).toBe(2);
  } finally {
    director.dispose();
  }
  await vi.waitFor(() => expect(relay.stats.openIterators).toBe(0));
});
