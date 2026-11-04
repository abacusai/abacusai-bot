/**
 * The two preview filters that keep a chat-list sweep honest.
 *
 * Both come from one real transcript: "typing…" delivered as a message from
 * the sender, and the bot's own outgoing replies reported back in as inbound:
 * a badge left by an earlier real message keeps the row in the sweep, and
 * the preview then shows whatever was said LAST, direction unknown.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isEphemeralPreview,
  normalizeScrapedText,
  PageLock,
  pageScript,
  PollScheduler,
  previewMatchesSent,
  runPageScript,
  saveInboundMedia,
} from "./connector";

describe("saveInboundMedia", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps every file of an album saved in one millisecond under one name", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-media-"));
    vi.stubEnv("ABACUSAI_BOT_HOME", home);
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    const pages = ["page one", "page two", "page three"];
    const saved = pages.map((page) =>
      saveInboundMedia("whatsapp", "phone", "image.jpg", Buffer.from(page))
    );

    expect(new Set(saved).size).toBe(pages.length);
    expect(saved.map((file) => fs.readFileSync(file, "utf8"))).toEqual(pages);
    fs.rmSync(home, { recursive: true });
  });
});

describe("isEphemeralPreview", () => {
  it("catches presence strings, with or without the ellipsis", () => {
    for (const text of [
      "typing…",
      "typing...",
      "Typing…",
      "recording audio…",
      "online",
    ])
      expect(isEphemeralPreview(text), text).toBe(true);
  });

  it("leaves real messages alone, even ones starting the same way", () => {
    for (const text of [
      "typing test now",
      "are you online later?",
      "recording audio for the podcast went well",
      "hey",
    ])
      expect(isEphemeralPreview(text), text).toBe(false);
  });
});

describe("previewMatchesSent", () => {
  /**
   * The report: a bot answering a group read its own replies back as incoming
   * messages and answered those, then answered the answers, including
   * commentary meant for the user, delivered to the group.
   *
   * A group preview names its speaker. Ours reads "You: ", which matched
   * nothing we had sent, so every outgoing message came straight back in.
   */
  it('sees through a group\'s "You:" prefix on our own message', () => {
    expect(previewMatchesSent(["on my way"], "You: on my way")).toBe(true);
  });

  it("sees through it when the preview is also clipped", () => {
    expect(
      previewMatchesSent(
        ["I appreciate the message, but I should clarify something"],
        "You: I appreciate the message, but I should…"
      )
    ).toBe(true);
  });

  it("still lets a real message from someone else through", () => {
    // Losing "Alice: " from the front does not turn her words into ours.
    expect(previewMatchesSent(["on my way"], "Alice: are you coming?")).toBe(
      false
    );
  });

  it("can mistake a prefixed message for an echo, and that is the trade", () => {
    // The honest limit of matching on text. "Reminder: pick up the keys" is a
    // message, not a speaker, so dropping its first word makes it look like
    // something we sent, and it would be skipped.
    //
    // Taken knowingly. Missing this costs one dropped message in a contrived
    // case; missing an echo costs a loop that spams a real group with the
    // bot's own words until someone notices, which is what happened. The
    // gateway's burst breaker is what stops that being unbounded either way.
    expect(
      previewMatchesSent(["pick up the keys"], "Reminder: pick up the keys")
    ).toBe(true);
  });

  it("matches the chunk that is actually previewed, not only the first", () => {
    // A long reply is chunked; the preview shows the last one.
    expect(previewMatchesSent(["part one", "part two"], "You: part two")).toBe(
      true
    );
  });

  it("matches our own text exactly", () => {
    expect(
      previewMatchesSent(
        "haha all good 😄 talk then?",
        "haha all good 😄 talk then?"
      )
    ).toBe(true);
  });

  it("matches a truncated preview of a longer send", () => {
    expect(
      previewMatchesSent(
        "only 2? how many of you are coming for badminton? we'll need enough to rotate",
        "only 2? how many of you are coming for…"
      )
    ).toBe(true);
  });

  it("does not match a genuine reply", () => {
    expect(
      previewMatchesSent("how many rackets do you all have?", "2 for now")
    ).toBe(false);
  });

  it("never matches when nothing was sent", () => {
    expect(previewMatchesSent(undefined, "anything")).toBe(false);
  });

  it("sees through WhatsApp's bidi wrapping", () => {
    // The exact failure from the field: the preview arrives as
    // \u202aHii!\u202c and the naive compare let the bot's own reply back
    // in as a message from the sender.
    expect(previewMatchesSent("Hii!", "\u202aHii!\u202c")).toBe(true);
  });

  it("guards every recent send, not only the last", () => {
    // A two-message reply left only its final chunk guarded; the first one
    // could echo back in as inbound.
    const ring = ["first part of the answer", "and the second"];
    expect(previewMatchesSent(ring, "first part of the answer")).toBe(true);
    expect(previewMatchesSent(ring, "and the second")).toBe(true);
    expect(previewMatchesSent(ring, "a genuine reply")).toBe(false);
    expect(previewMatchesSent([], "anything")).toBe(false);
  });
});

describe("normalizeScrapedText", () => {
  it("removes invisible characters and rendered whitespace runs", () => {
    expect(normalizeScrapedText("\u202aWhat's today's weather\u202c")).toBe(
      "What's today's weather"
    );
    expect(normalizeScrapedText("zero\u200bwidth\u2060joined")).toBe(
      "zerowidthjoined"
    );
    expect(normalizeScrapedText("  spaced \t out  ")).toBe("spaced out");
    expect(normalizeScrapedText("plain")).toBe("plain");
  });
});

describe("PollScheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("never queues a run behind a slow one, and holds while paused", async () => {
    vi.useFakeTimers();
    let runs = 0;
    let running = 0;
    let overlapped = false;
    const poll = new PollScheduler(
      async () => {
        runs += 1;
        running += 1;
        if (running > 1) overlapped = true;
        // Slower than the interval: a page answering slowly after a sleep.
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        running -= 1;
      },
      5_000,
      () => {}
    );
    poll.start();
    await vi.advanceTimersByTimeAsync(5_000 + 3 * 35_000);
    expect(runs).toBe(4);
    expect(overlapped).toBe(false);

    poll.pause();
    await vi.advanceTimersByTimeAsync(30_000); // the one in flight finishes
    const paused = runs;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs).toBe(paused);

    poll.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(paused + 1);
    poll.stop();
  });
});

describe("PageLock", () => {
  afterEach(() => vi.useRealTimers());

  it("lets a user call go ahead of queued background work", async () => {
    const lock = new PageLock();
    const order: string[] = [];
    let release: () => void = () => {};
    const first = lock.run(
      () => new Promise<void>((resolve) => (release = resolve))
    );
    const sweep = lock.run(async () => void order.push("sweep"));
    const read = lock.run(async () => void order.push("read"), { user: true });
    release();
    await Promise.all([first, sweep, read]);
    expect(order).toEqual(["read", "sweep"]);
  });

  it("drops a call whose deadline passes in the queue, and cuts one short that may be", async () => {
    vi.useFakeTimers();
    const lock = new PageLock();
    let ranLate = false;
    let aborted = false;
    const holder = lock.run(
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        }),
      { user: true, deadlineMs: 10_000, interruptible: true }
    );
    const queued = lock.run(
      async () => {
        ranLate = true;
      },
      { user: true, deadlineMs: 5_000, timeoutError: () => new Error("late") }
    );
    const holderResult = holder.catch((e: Error) => e.message);
    const queuedResult = queued.catch((e: Error) => e.message);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(await queuedResult).toBe("late");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await holderResult).toBe("The page did not answer.");
    expect(aborted).toBe(true);
    expect(ranLate).toBe(false);
    expect(lock.busy).toBe(false);
  });
});

describe("runPageScript", () => {
  // Arguments are data from chats and the agent; none may become code.
  const hostile = {
    quote: `he said "hi" and 'bye'`,
    tag: "</script><script>globalThis.pwned = 1</script>",
    separators: "line\u2028para\u2029end",
    backtick: "`${globalThis.pwned = 1}`",
    breakout: '"})();globalThis.pwned = 1;(async function(){ //',
    nested: { list: ["<!--", "-->", "&amp;", "\\", "\n"] },
  };

  it("hands arguments over unchanged, and none of them runs", async () => {
    let code = "";
    const context = vm.createContext({});
    const contents = {
      executeJavaScript: async (source: string) => {
        code = source;
        return vm.runInContext(source, context);
      },
    };

    const echoed = await runPageScript(
      contents,
      pageScript`return args;`,
      hostile
    );

    expect(echoed).toEqual(hostile);
    expect(vm.runInContext("globalThis.pwned", context)).toBeUndefined();
    // Safe to sit in an HTML script block or a single line, too.
    expect(code).not.toMatch(/[<>&\u2028\u2029]/);
  });

  it("splices only page scripts into page scripts", () => {
    const helper = pageScript`const twice = (n) => n * 2;`;
    expect(pageScript`${helper} return twice(args.n);`).toBe(
      "const twice = (n) => n * 2; return twice(args.n);"
    );
  });
});
