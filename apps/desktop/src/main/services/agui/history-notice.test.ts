/**
 * A v1 history too large to read at all (the thread store's `too-large`
 * notice, cut-over review r2 #8) reaches the client through `ai.hydrate` as
 * the session-scoped notice `abacus.notice`, once, so the chat kit can say
 * so and offer Show in folder instead of showing an empty conversation.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { connectInProcess, fakeDeps } from "../../rpc/testing";
import { ThreadStore } from "../session/thread-store";
import { AguiRelayService } from "./relay-service";
import { HISTORY_NOTICE_KEY } from "./thread-relay";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agui-notice-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const relayOver = (store: ThreadStore) =>
  new AguiRelayService({
    host: {
      workspaceOf: () => "w",
      runtime: () => null,
      start: async () => false,
      send: () => null,
      markSent: () => undefined,
      markStopped: () => undefined,
    },
    files: store,
    log: () => undefined,
  });

describe("an oversized thread's hydrate", () => {
  it("carries one abacus.notice with the size, limit and transcript path, and no messages", async () => {
    const transcripts = path.join(home, "transcripts");
    fs.mkdirSync(transcripts, { recursive: true });
    const text = JSON.stringify({
      version: 1,
      sessionId: "big-1",
      updatedAt: new Date(0).toISOString(),
      segments: [
        { id: "t", type: "text", source: "bot", content: "x".repeat(4_000) },
      ],
    });
    fs.writeFileSync(path.join(transcripts, "big-1.json"), text);
    const store = new ThreadStore({
      home: () => home,
      log: () => undefined,
      maxTranscriptBytes: 1_000,
      maxStreamedBytes: 2_000,
    });
    expect(store.readCurrentWithNotice("big-1").notice?.kind).toBe("too-large");

    const client = connectInProcess(fakeDeps({ ai: relayOver(store) })).client;
    const first = await client.ai.hydrate({ threadId: "big-1" });
    expect(first.messages).toEqual([]);
    expect(first.abacus.notices).toEqual([
      {
        seq: expect.any(Number),
        name: "abacus.notice",
        value: {
          kind: "too-large",
          size: Buffer.byteLength(text),
          limit: 2_000,
          path: path.join(transcripts, "big-1.json"),
          notificationKey: HISTORY_NOTICE_KEY,
        },
      },
    ]);
    // Hydrating again does not repeat it.
    const again = await client.ai.hydrate({ threadId: "big-1" });
    expect(again.abacus.notices).toHaveLength(1);

    // An ordinary thread carries none.
    const plain = await client.ai.hydrate({ threadId: "small-1" });
    expect(plain.abacus.notices).toEqual([]);
  });
});
