/**
 * A reply stream cut after the model said something and began a tool call:
 * pi retries, and the retry says it again and makes the call under a new id.
 * The cut attempt is superseded, so no transcript holds its text or call:
 * not the live one, not a later window's hydrate, not the file main
 * persisted. Memory transport + real host.
 */
import type { UIMessage } from "@tanstack/ai-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { messageTools } from "#renderer/lib/bot-turns/tool-parts";
import {
  REAL_THREAD,
  startRealHost,
  type RealHost,
} from "#renderer/test-support/real-host";

import { runningTools } from "../kit/status/status";
import { createChatRuntime, type ChatRuntime } from "./runtime";
import type { ThreadSession } from "./session";

const WAIT = { timeout: 30_000, interval: 10 };
const SAID = "Let me look.";

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
    reply: (index) =>
      index === 0
        ? { cut: { say: SAID, call: "ls" } }
        : index === 1
          ? { say: SAID, call: { name: "ls", args: { path: "." } } }
          : { say: "Listed." },
  });
}, 30_000);

afterAll(async () => {
  for (const runtime of runtimes) runtime.forget(REAL_THREAD);
  await host?.close();
}, 30_000);

const callIds = (messages: readonly UIMessage[]): string[] =>
  messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.type === "tool-call"
        ? [part.id]
        : part.type === "tool-result"
          ? [part.toolCallId]
          : []
    )
  );

/** What every reader of a transcript sees of its text and tool calls. */
const readers = (messages: readonly UIMessage[]) => ({
  said: messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "text" && part.content.includes(SAID))
    .length,
  tools: messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) => messageTools(message))
    .map((tool) => `${tool.name}:${tool.settled}`),
  running: runningTools(messages),
});

describe("the attempt a cut reply stream superseded", () => {
  let live: ThreadSession;
  /** The call the cut began. */
  let discarded: string;

  beforeAll(async () => {
    live = await open();
    const entry = live.submit("list the files");
    await expect(entry).resolves.toMatchObject({ kind: "started" });
    await vi.waitFor(
      () => expect(live.store.state.runs.outcomes).toHaveLength(1),
      WAIT
    );
    const started = host
      .agentEvents()
      .filter((event) => event.type === "TOOL_CALL_START")
      .map((event) => String(event.toolCallId));
    // The cut began a call, and the retry made it again under a new id.
    expect(started).toHaveLength(2);
    discarded = started[0]!;
  }, 60_000);

  it.each([
    ["the live window", async () => live.hostStore.state.messages],
    [
      "a later window's hydrate",
      async () => (await open()).hostStore.state.messages,
    ],
    [
      "the file main persisted",
      async () => host.persisted()!.messages as UIMessage[],
    ],
    [
      "a restarted main's hydrate",
      async () => {
        await host.restartMain();
        return (await open()).hostStore.state.messages;
      },
    ],
  ])(
    "%s holds only the retry: its text once, its call",
    async (_name, read) => {
      const messages = await read();
      expect(callIds(messages)).not.toContain(discarded);
      expect(readers(messages)).toEqual({
        said: 1,
        tools: ["ls:true"],
        running: [],
      });
    },
    30_000
  );

  it("counts one step for the run", () => {
    expect(live.store.state.runs.outcomes.at(-1)?.steps).toBe(1);
  });
});
