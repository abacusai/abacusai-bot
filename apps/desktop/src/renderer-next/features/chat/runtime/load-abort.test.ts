import { expect, it, vi } from "vitest";

import type { AiClient } from "#next/data/ai";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { ThreadSession } from "./session";

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
it("R6-T17 abort affects only its waiter while a shared load completes", async () => {
  const relay = new FakeRelay();
  relay.emitAll(b.sessionReady());
  const pending = gate();
  let hydrateSignal: AbortSignal | undefined;
  const ai: AiClient = {
    ...relay.ai,
    hydrate: async (input, options) => {
      hydrateSignal = options?.signal;
      await pending.promise;
      return relay.ai.hydrate(input, options);
    },
  };
  const session = new ThreadSession({ ai, threadId: relay.threadId });
  const abort = new AbortController();
  const first = session.load({ signal: abort.signal });
  const second = session.load();
  abort.abort();
  await expect(first).rejects.toMatchObject({ name: "AbortError" });
  expect(hydrateSignal?.aborted).toBe(false);
  pending.release();
  await second;
  expect(session.ready).toBe(true);
  session.retire();
  await vi.waitFor(() => expect(relay.stats.openIterators).toBe(0));
});
it("R6-T17 last waiter abort retires stalled hydrate and no iterator leaks", async () => {
  const relay = new FakeRelay();
  relay.emitAll(b.sessionReady());
  let hydrateSignal: AbortSignal | undefined;
  const ai: AiClient = {
    ...relay.ai,
    hydrate: (_input, options) =>
      new Promise((_resolve, reject) => {
        hydrateSignal = options?.signal;
        hydrateSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      }),
  };
  const session = new ThreadSession({ ai, threadId: relay.threadId });
  const abort = new AbortController();
  const pending = session.load({ signal: abort.signal });
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(hydrateSignal?.aborted).toBe(true);
  expect(session.retired).toBe(true);
  await vi.waitFor(() => expect(relay.stats.openIterators).toBe(0));
});
