import { expect, it, vi } from "vitest";

import { createChatRuntime } from "#next/features/chat";
import * as b from "#next/features/chat/fixtures/builders";
import { FakeRelay } from "#next/features/chat/fixtures/relay";

it("R6-T19 twenty real kit sessions keep at most two subscription iterators", async () => {
  const relay = new FakeRelay();
  relay.emitAll(b.sessionReady());
  const runtime = createChatRuntime(relay.ai, { maxSessions: 2 });
  const held: string[] = [];
  let peak = 0;
  try {
    for (let index = 0; index < 20; index += 1) {
      const id = `thread-${index}`;
      if (held.length === 2) runtime.forget(held.shift()!);
      held.push(id);
      await runtime.session(id).load();
      await vi.waitFor(() =>
        expect(relay.stats.openIterators).toBe(held.length)
      );
      peak = Math.max(peak, relay.stats.openIterators);
    }
    expect(peak).toBe(2);
  } finally {
    for (const id of held) runtime.forget(id);
  }
  await vi.waitFor(() => expect(relay.stats.openIterators).toBe(0));
  await runtime.session("thread-0").load();
  await vi.waitFor(() => expect(relay.stats.openIterators).toBe(1));
  runtime.forget("thread-0");
  await vi.waitFor(() => expect(relay.stats.openIterators).toBe(0));
});
