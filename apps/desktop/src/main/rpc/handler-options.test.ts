/**
 * Errors inside event iterators get the same mapping and logging as a call's
 * (spec 00 A.4.2, A.5; Codex impl-r1 #9, Claude impl-r1 #3). oRPC consumes a
 * returned iterator after the interceptor returned, so without the wrapper a
 * failed snapshot or a mid-stream failure reached the client as oRPC's
 * generic "Internal server error" and was never logged.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { WORKSPACE_MISSING_ERROR } from "@abacus-ai/contract/contracts";

import { UnavailableAguiSource } from "./ai/source";
import {
  connectInProcess,
  fakeDeps,
  type InProcessConnection,
} from "./testing";

const connections: InProcessConnection[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const connection of connections.splice(0)) {
    connection.closeClient();
    connection.closeServer();
  }
});

const connect = (deps: ReturnType<typeof fakeDeps>) => {
  const connection = connectInProcess(deps);
  connections.push(connection);
  return connection.client;
};

describe("errors inside event iterators", () => {
  it("maps and logs a snapshot that fails before the first yield", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = connect(
      fakeDeps({
        serviceHost: {
          listConnectorRequests: () => {
            throw new Error("gate exploded");
          },
        },
      })
    );

    const events = await client.connectors.events({});
    await expect(events.next()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "gate exploded",
    });
    expect(error).toHaveBeenCalledWith(
      "[rpc] connectors.events INTERNAL_SERVER_ERROR gate exploded",
      expect.anything(),
      expect.any(Error)
    );
  });

  it("maps a workspace-missing failure to its precondition", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = connect(
      fakeDeps({
        serviceHost: {
          listTerminalStates: () => {
            throw new Error(`${WORKSPACE_MISSING_ERROR}:/gone`);
          },
        },
      })
    );

    const events = await client.terminal.events({});
    await expect(events.next()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      defined: true,
      data: { reason: "workspace-missing" },
    });
  });

  it("maps and logs a failure after the first yield", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ai = new UnavailableAguiSource();
    ai.subscribe = async function* () {
      yield { seq: 1, event: { type: "CUSTOM", name: "x", value: 1 } as never };
      throw new Error("ring lost");
    };
    const client = connect(fakeDeps({ ai }));

    const chunks = await client.ai.subscribe({ threadId: "t1" });
    await expect(chunks.next()).resolves.toMatchObject({ done: false });
    await expect(chunks.next()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "ring lost",
    });
    expect(error).toHaveBeenCalledWith(
      "[rpc] ai.subscribe INTERNAL_SERVER_ERROR ring lost",
      expect.anything(),
      expect.any(Error)
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
