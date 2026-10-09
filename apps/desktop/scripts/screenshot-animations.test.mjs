import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { settleAnimations } from "../../web/src/lib/dev/settle.ts";
import { animationsDone } from "./screenshots.mjs";

const fixture = (animation, timeoutMs = 100) => {
  const document = { timeline: {}, getAnimations: () => [animation] };
  const frame = (callback) => setTimeout(callback, 2);
  const context = {
    document,
    window: {
      __abacusDev: {
        animationsDone: () => settleAnimations(document, frame, 10, timeoutMs),
      },
    },
  };
  return { evaluate: (expression) => vm.runInNewContext(expression, context) };
};

const animation = (timeline = null) => ({
  timeline,
  playState: "running",
  effect: { getComputedTiming: () => ({ endTime: 200 }) },
  finished: new Promise(() => {}),
});

const bounded = async (promise) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("screenshot animation wait hung")),
          1000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

test("capture waits for a finite fade even when its finished promise stays pending", async () => {
  const fade = animation();
  const started = Date.now();
  const timer = setTimeout(() => {
    fade.playState = "finished";
  }, 200);
  try {
    await bounded(animationsDone(fixture(fade, 800)));
    assert.ok(Date.now() - started >= 180, "capture must wait for the fade");
  } finally {
    clearTimeout(timer);
  }
});

test("capture does not wait for a scroll timeline to reach its end", async () => {
  const scroll = animation({ source: {} });
  await bounded(animationsDone(fixture(scroll)));
  assert.equal(scroll.playState, "running");
});

test("a genuinely stalled finite animation rejects instead of allowing a capture", async () => {
  await assert.rejects(
    bounded(animationsDone(fixture(animation()))),
    /finite animations did not settle/
  );
});
