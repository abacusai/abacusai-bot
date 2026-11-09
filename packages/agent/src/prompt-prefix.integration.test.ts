/**
 * A new chat lands where the provider has not seen it, so its first request
 * reuses only the prefix other users' requests already cached: everything
 * shared by every user must come before anything that is theirs alone.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, expect, it } from "vitest";

import { stopProvider } from "./agui/__tests__/harness.js";
import { live, runInput } from "./agui/__tests__/live.js";

afterAll(async () => {
  await stopProvider();
});

/** The system prompt of a user's first request. */
const firstSystemPrompt = async (
  env: Record<string, string>,
  plan: Record<string, unknown>,
  account: object
): Promise<string> => {
  const l = await live({
    isolated: true,
    reply: () => ({ say: "ok" }),
    env,
    setup: () => {
      fs.writeFileSync(
        path.join(process.env.ABACUSAI_BOT_HOME ?? "", "account.json"),
        JSON.stringify(account)
      );
    },
  });
  try {
    l.send({ type: "account_plan", ...plan });
    l.send(runInput("r0", "hello"));
    await l.waitFor(
      (all) => all.some((event) => event.type === "RUN_FINISHED"),
      "run"
    );
    const content = l
      .calls()[0]
      ?.messages.find((m) => m.role === "system")?.content;

    return typeof content === "string" ? content : JSON.stringify(content);
  } finally {
    await l.close();
  }
};

it(
  "puts every per-user block after the blocks all users share",
  {
    timeout: 60_000,
  },
  async () => {
    const a = await firstSystemPrompt(
      {
        TZ: "America/New_York",
        ABACUSAI_BOT_MEMORY_SNAPSHOT: "- Writes a gardening blog",
        ABACUSAI_BOT_LOCALE: "en-US",
      },
      { tier: "free", name: null },
      { account: { username: "Alex" }, apps: [{ name: "Gmail" }] }
    );
    const b = await firstSystemPrompt(
      {
        TZ: "Asia/Tokyo",
        ABACUSAI_BOT_MEMORY_SNAPSHOT: "- Runs a bakery",
        ABACUSAI_BOT_LOCALE: "de-DE",
      },
      { tier: "paid", name: "Pro" },
      { account: { username: "Sam" }, apps: [{ name: "Slack" }] }
    );

    let shared = 0;
    while (shared < a.length && a[shared] === b[shared]) shared++;
    const prefix = a.slice(0, shared);

    // The last shared block is in the common prefix, and the first per-user one starts it off.
    expect(prefix).toContain("Handing over what you made:");
    expect(a.slice(shared - 40)).toContain("The user's local timezone is");
  }
);
