import { contract } from "@abacus-ai/contract/contract";
import type { SystemInfo } from "@abacus-ai/contract/contract";
/**
 * The Transport a renderer gets, over the test double: the real oRPC link
 * and handler on an in-process MessageChannel, the typed client, and the
 * TanStack Query utilities with stable keys.
 */
import { implement, type Router } from "@orpc/server";
import { partialMatchKey } from "@tanstack/query-core";
import { afterEach, describe, expect, it } from "vitest";

import { createMemoryTransport, type MemoryTransport } from "./memory";

const impl = implement(contract).$context<{ calls: string[] }>();

const INFO: SystemInfo = {
  appVersion: "1.2.3",
  platform: "darwin",
  arch: "arm64",
  versions: { electron: "44.4.5" },
  homeDir: "/Users/ada",
  paths: { home: "/Users/ada", sessionHome: "/s", botHome: "/b" },
  materialIconsBasePath: null,
  contractVersion: 1,
  foundationApi: 1,
};

/** Just the procedures these cases call; the double takes any router. */
const router = {
  system: {
    info: impl.system.info.handler(({ context }) => {
      context.calls.push("system.info");
      return INFO;
    }),
  },
  files: {
    treeChildren: impl.files.treeChildren.handler(({ input }) => [
      {
        id: input.directoryPath,
        name: "a.txt",
        absolutePath: `${input.directoryPath}/a.txt`,
        relativePath: "a.txt",
        kind: "file" as const,
        hasChildren: false,
      },
    ]),
  },
  devices: {
    screenshot: impl.devices.screenshot.handler(() => ({
      dataUrl: "data:image/png;base64,",
    })),
  },
} as unknown as Router<any, { calls: string[] }>;

let transport: MemoryTransport | null = null;

afterEach(() => {
  transport?.close();
  transport = null;
});

describe("the renderer Transport", () => {
  it("calls main through a typed client", async () => {
    const calls: string[] = [];
    transport = createMemoryTransport(router, { calls });

    await expect(transport.client.system.info()).resolves.toEqual(INFO);
    expect(calls).toEqual(["system.info"]);
    expect(transport.kind).toBe("memory");
  });

  it("builds query options whose keys name the procedure and input", async () => {
    transport = createMemoryTransport(router, { calls: [] });
    const options = transport.orpc.files.treeChildren.queryOptions({
      input: { directoryPath: "/w" },
    });

    expect(options.queryKey).toEqual(
      transport.orpc.files.treeChildren.queryKey({
        input: { directoryPath: "/w" },
      })
    );
    expect(JSON.stringify(options.queryKey)).toContain("treeChildren");
    // The key of the whole domain matches every key inside it, which is
    // what an invalidation by domain relies on.
    expect(partialMatchKey(options.queryKey, transport.orpc.files.key())).toBe(
      true
    );
    expect(partialMatchKey(options.queryKey, transport.orpc.system.key())).toBe(
      false
    );

    const rows = await (
      options.queryFn as (context: unknown) => Promise<unknown>
    )({ signal: new AbortController().signal, queryKey: options.queryKey });
    expect(rows).toMatchObject([{ name: "a.txt" }]);
  });

  it("rejects with BAD_REQUEST on input that fails the contract", async () => {
    transport = createMemoryTransport(router, { calls: [] });

    await expect(
      transport.client.devices.screenshot({
        platform: "windows-phone",
      } as never)
    ).rejects.toMatchObject({ code: "BAD_REQUEST", defined: true });
  });

  it("passes the preload's host helpers through", () => {
    const getPathForFile = (): string => "/x";
    transport = createMemoryTransport(
      router,
      { calls: [] },
      { host: { getPathForFile } }
    );

    expect(transport.host.getPathForFile).toBe(getPathForFile);
  });
});
