/**
 * The stale-page heal reads the chat before resending, and that read must
 * distinguish a message that just landed from one the chat said days ago.
 *
 * The report: "send hi on whatsapp" reported delivered; nothing arrived. The
 * self-chat already held a "hi", the read-back matched it, and the heal
 * concluded "landed after all" while the real send never went out. The fix
 * is a pre-send baseline: landed means MORE matching outgoing bubbles than
 * before, not merely one present.
 *
 * This runs the actual RECENT_OUT_SCRIPT string against a hand-built DOM, so
 * the executable page logic is what is under test, not a paraphrase.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE = fs.readFileSync(
  path.join(__dirname, "whatsapp-web-connector.ts"),
  "utf8"
);

const script = (name: string): string => {
  const match = SOURCE.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
  if (match == null) throw new Error(`${name} not found`);
  return match[1];
};

type Bubble = { out: boolean; text: string };

/** The narrow slice of the DOM the outgoing-bubble scan touches. */
const fakeDocument = (bubbles: Bubble[]): unknown => {
  const rect = (out: boolean) => ({
    x: out ? 400 : 0,
    width: 100,
    height: 20,
  });
  const nodes = bubbles.map((bubble) => ({
    classList: {
      contains: (cls: string) =>
        cls === (bubble.out ? "message-out" : "message-in"),
    },
    getBoundingClientRect: () => rect(bubble.out),
    innerText: bubble.text,
  }));
  const main = {
    getBoundingClientRect: () => ({ x: 0, width: 600, height: 800 }),
    querySelectorAll: () => nodes,
  };
  return {
    querySelector: (sel: string) => (sel === "#main" ? main : null),
    querySelectorAll: () => nodes,
  };
};

const runRecentOut = async (
  bubbles: Bubble[],
  priorMatches: number
): Promise<boolean> => {
  const fn = new (Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (
    args: unknown,
    document: unknown,
    window: unknown
  ) => Promise<{ found: boolean }>)(
    "args",
    "document",
    "window",
    script("RECENT_OUT_SCRIPT")
  );
  const result = await fn.call(
    null,
    { head: "hi", priorMatches },
    fakeDocument(bubbles),
    {}
  );
  return result.found;
};

describe("the heal's read-back", () => {
  it("does not count a stale match as a fresh delivery", async () => {
    // One old "hi" was there before the send, and it is still the only one.
    const found = await runRecentOut([{ out: true, text: "hi" }], 1);
    expect(found).toBe(false);
  }, 12_000);

  it("counts a genuinely new bubble as delivered", async () => {
    // Two "hi" bubbles now, one before: the send landed.
    const found = await runRecentOut(
      [
        { out: true, text: "hi" },
        { out: true, text: "hi" },
      ],
      1
    );
    expect(found).toBe(true);
  });

  it("finds the first send in a chat that never held the text", async () => {
    const found = await runRecentOut([{ out: true, text: "hi" }], 0);
    expect(found).toBe(true);
  });

  it("ignores an incoming bubble that happens to contain the text", async () => {
    const found = await runRecentOut(
      [
        { out: true, text: "hi" },
        { out: false, text: "hi back" },
      ],
      1
    );
    expect(found).toBe(false);
  }, 12_000);
});
