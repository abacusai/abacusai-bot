import { expect, it } from "vitest";

import { FakeRelay } from "../fixtures/relay";
import { ThreadSession } from "./session";

it("R4-T13 re-admits a persisted envelope with the same identities after reload", async () => {
  const calls: unknown[] = [];
  const relay = new FakeRelay({
    onSend: (input) => {
      calls.push(input);
      return { status: "started", runId: input.runId } as never;
    },
  });
  const envelope = {
    runId: "run-persisted",
    messageId: "u-persisted",
    parts: [{ type: "text" as const, content: "hello\n\n@/file" }],
  };
  const first = new ThreadSession({ threadId: relay.threadId, ai: relay.ai });
  await first.admitEnvelope(envelope);
  first.retire();
  const second = new ThreadSession({ threadId: relay.threadId, ai: relay.ai });
  await second.admitEnvelope(envelope);
  second.retire();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    runId: envelope.runId,
    messages: [{ id: envelope.messageId, parts: envelope.parts }],
  });
});
