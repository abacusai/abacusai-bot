/**
 * R2-T6 (spec 02 §3.4, finding r1-3): the user message a window sends is
 * shown once, as the agent's own echo (`AguiHost.onRun`, `host.ts:327-331`)
 * with the client's id, and main adds no echo of its own. Memory transport
 * + real host: main's `ai.*` router and `AguiRelayService` over a
 * `MessageChannel`, fed by a real `AguiHost` against the fake provider.
 */
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

const textOf = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => (part as { content: string }).content)
    .join("");

const userMessages = (session: ThreadSession, id: string): UIMessage[] =>
  session.hostStore.state.messages.filter(
    (message) => message.role === "user" && message.id === id
  );

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
    reply: (index) => ({ say: `Reply ${index}.` }),
  });
}, 30_000);

afterAll(async () => {
  for (const runtime of runtimes) runtime.forget(REAL_THREAD);
  await host?.close();
}, 30_000);

const TEXTS = {
  "single-line": "Hello there",
  "multi-line": "First line\n\nSecond line\n  indented third\n- a list item",
  "20 KB": Array.from(
    { length: 400 },
    (_, index) => `Line ${index}: ${"lorem ipsum dolor ".repeat(2)}`
  ).join("\n"),
};

describe("R2-T6 user echo (memory transport + real host)", () => {
  let windowA: ThreadSession;
  let windowB: ThreadSession;
  const sent: Array<{ id: string; text: string }> = [];

  beforeAll(async () => {
    windowA = await open();
    windowB = await open();
  }, 30_000);

  it.each(Object.entries(TEXTS))(
    "a %s message is one user message with unchanged text in both windows",
    async (_name, text) => {
      expect(text.length).toBeGreaterThan(0);
      const pending = windowA.submit(text);
      // The pending bubble has the id the agent will echo.
      const entry = windowA.hostStore.state.outbox.at(-1)!;
      await expect(pending).resolves.toMatchObject({ kind: "started" });
      sent.push({ id: entry.id, text });

      // The run finished in both windows.
      for (const session of [windowA, windowB])
        await vi.waitFor(
          () =>
            expect(
              session.store.state.runs.outcomes.map((o) => o.runId)
            ).toContain(entry.runId),
          WAIT
        );
      expect(windowA.hostStore.state.outbox).toEqual([]);

      for (const session of [windowA, windowB]) {
        const users = userMessages(session, entry.id);
        expect(users).toHaveLength(1);
        expect(textOf(users[0]!)).toBe(text);
      }

      // The one echo is the agent's: one user TEXT_MESSAGE_START with the
      // client's id on the agent's stdout, and the relay added none.
      const starts = host
        .agentEvents()
        .filter(
          (event) =>
            event.type === "TEXT_MESSAGE_START" && event.messageId === entry.id
        );
      expect(starts).toEqual([
        expect.objectContaining({ role: "user", messageId: entry.id }),
      ]);
    },
    30_000
  );

  it("a later hydrate shows each message once, unchanged", async () => {
    expect(sent).toHaveLength(3);
    // Main wrote one `run` per prompt to the real agent.
    expect(host.runsWritten()).toHaveLength(3);
    const later = await open();
    for (const { id, text } of sent) {
      const users = userMessages(later, id);
      expect(users).toHaveLength(1);
      expect(textOf(users[0]!)).toBe(text);
    }
    // Nothing else the user sent appears: three prompts, three messages.
    expect(
      later.hostStore.state.messages.filter((m) => m.role === "user")
    ).toHaveLength(3);
  }, 30_000);
});
