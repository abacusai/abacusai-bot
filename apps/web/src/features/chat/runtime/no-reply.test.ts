/**
 * A routine run that found nothing new narrates its checks and ends on the
 * silent `NO_REPLY`. The narration is the report; the token is never shown,
 * live or rehydrated. Memory transport + real host.
 */
import { withoutNoReply } from "@abacus-ai/contract/contract/ai";
import type { UIMessage } from "@tanstack/ai-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  REAL_THREAD,
  startRealHost,
  type RealHost,
} from "#renderer/test-support/real-host";

import { createChatRuntime, type ChatRuntime } from "./runtime";
import type { ThreadSession } from "./session";

const WAIT = { timeout: 20_000, interval: 10 };
const NARRATION = "Checked the chat with Sam: no new message.";

let host: RealHost;
const runtimes: ChatRuntime[] = [];

const open = async (): Promise<ThreadSession> => {
  const runtime = createChatRuntime(await host.window());
  runtimes.push(runtime);
  const session = runtime.session(REAL_THREAD);
  await session.load();
  return session;
};

beforeAll(async () => {
  host = await startRealHost({
    reply: (index) => ({
      say: index === 0 ? `${NARRATION} NO_REPLY` : "NO_REPLY",
    }),
  });
}, 30_000);

afterAll(async () => {
  for (const runtime of runtimes) runtime.forget(REAL_THREAD);
  await host?.close();
}, 30_000);

const assistantTexts = (messages: readonly UIMessage[]): string[] =>
  messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.parts)
    .flatMap((part) => (part.type === "text" ? [part.content] : []));

describe("withoutNoReply", () => {
  it.each([
    ["NO_REPLY", ""],
    ["  NO_REPLY \n", ""],
    [`${NARRATION} NO_REPLY`, NARRATION],
    [`${NARRATION}\n\nNO_REPLY\n`, NARRATION],
    [`${NARRATION}NO_REPLY`, NARRATION],
    [NARRATION, NARRATION],
    ["A NO_REPLY in the middle stays.", "A NO_REPLY in the middle stays."],
    ["", ""],
  ])("%j reads as %j", (text, shown) => {
    expect(withoutNoReply(text)).toBe(shown);
  });
});

/** Sends `text` and waits for its run to finish. */
const run = async (session: ThreadSession, text: string): Promise<void> => {
  const pending = session.submit(text);
  const entry = session.hostStore.state.outbox.at(-1)!;
  await expect(pending).resolves.toMatchObject({ kind: "started" });
  await vi.waitFor(
    () =>
      expect(session.store.state.runs.outcomes.map((o) => o.runId)).toContain(
        entry.runId
      ),
    WAIT
  );
};

describe("a run that ends on NO_REPLY", () => {
  it("shows its narration without the token, live and rehydrated", async () => {
    const live = await open();
    await run(live, "Check the chat.");
    await run(live, "Check again.");
    const later = await open();
    for (const session of [live, later]) {
      const texts = assistantTexts(session.hostStore.state.messages);
      expect(texts).toContain(NARRATION);
      expect(texts.join("\n")).not.toContain("NO_REPLY");
    }
  }, 30_000);
});
