/**
 * A message steered in while the turn finishes its answer: both session kinds
 * (the plain one and a bot's forever chat) hand that answer over as
 * `turn_answer` for the first message, and `turn_reply` carries only what
 * came after. Chat lanes send exactly these, so neither may drop the answer.
 */
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { GOLDEN_ROOT, stopProvider } from "./__tests__/harness.js";
import { live } from "./__tests__/live.js";

afterAll(async () => {
  await stopProvider();
});

const BOT_DIR = path.join(GOLDEN_ROOT, "home", "bots", "bot-steer");

describe("an answer a steer lands behind", () => {
  for (const [kind, env] of [
    ["plain session", {}],
    ["bot chat", { ABACUSAI_BOT_BOT_DIR: BOT_DIR, PI_OFFLINE: "1" }],
  ] as const) {
    it(`is reported once, before the steer's own reply (${kind})`, async () => {
      const l = await live({
        realSessionChoice: true,
        isolated: true,
        env,
        reply: (index, gates) =>
          index === 0
            ? gates.wait("answer").then(() => ({
                say: "Your calendar is empty.",
              }))
            : { say: "4" },
      });
      const replies = () =>
        l.compat().flatMap((payload) =>
          payload.type === "event" &&
          (payload.event.type === "turn_answer" ||
            payload.event.type === "turn_reply")
            ? [
                {
                  type: payload.event.type,
                  messageIds: payload.event.messageIds,
                  text: payload.event.text,
                },
              ]
            : []
        );
      try {
        l.send({
          type: "send",
          message: "what is on my calendar?",
          messageId: "m1",
        });
        await l.waitFor(() => l.providerCalls() >= 1, "first call");
        // Sent while the answer is still on its way: the turn takes it as a steer.
        l.send({ type: "send", message: "2+2", messageId: "m2" });
        await new Promise((resolve) => setTimeout(resolve, 100));
        l.gates.open("answer");
        await l.waitFor(
          () => replies().some((reply) => reply.type === "turn_reply"),
          "turn reply"
        );

        expect(replies()).toEqual([
          {
            type: "turn_answer",
            messageIds: ["m1"],
            text: "Your calendar is empty.",
          },
          { type: "turn_reply", messageIds: ["m1", "m2"], text: "4" },
        ]);
      } finally {
        await l.close();
      }
    });
  }
});
