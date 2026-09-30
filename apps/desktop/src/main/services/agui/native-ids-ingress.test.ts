/**
 * The `#` reservation at `ai.send` (spec 00 C.3): a run id or the message
 * that enters the thread holding `#` (or `%`, the encoding's escape) is a
 * definitive BAD_REQUEST before anything is written or reserved, so no id a
 * client sends can equal one the v1 mapper derived.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { connectInProcess, fakeDeps } from "../../rpc/testing";
import { ThreadStore } from "../session/thread-store";
import { AguiRelayService } from "./relay-service";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agui-ids-"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("ai.send and reserved ids", () => {
  it("refuses # or % in the run id or the entering message id, and writes nothing", async () => {
    const written: object[] = [];
    let starts = 0;
    const relay = new AguiRelayService({
      host: {
        workspaceOf: () => "w",
        runtime: () => ({ wire: "agui", status: "running" }),
        start: async () => {
          starts += 1;
          return true;
        },
        send: (_threadId, command) => {
          written.push(command);
          return {};
        },
        markSent: () => undefined,
        markStopped: () => undefined,
      },
      files: new ThreadStore({ home: () => home, log: () => undefined }),
      aguiForEverySpawn: true,
      ackTimeoutMs: 50,
      log: () => undefined,
    });
    const client = connectInProcess(fakeDeps({ ai: relay })).client;
    const user = (id: string) => ({
      id,
      role: "user" as const,
      parts: [{ type: "text", content: "hi" }],
    });

    for (const [runId, messageId] of [
      ["run#1", "u-1"],
      ["run-1", "u#1"],
      ["run-2", "u%231"],
    ] as const)
      await expect(
        client.ai.send({ threadId: "s1", runId, messages: [user(messageId)] })
      ).rejects.toMatchObject({ code: "BAD_REQUEST", defined: true });
    expect(written).toEqual([]);
    expect(starts).toBe(0);
    expect(relay.busy).toBe(false);

    // History the mapper produced (older messages) may keep its # ids.
    await expect(
      client.ai.send({
        threadId: "s1",
        runId: "run-3",
        messages: [user("seg#2"), user("u-3")],
      })
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(written).toHaveLength(1);
  });
});
