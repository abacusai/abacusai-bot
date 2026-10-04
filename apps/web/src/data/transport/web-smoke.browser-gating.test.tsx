import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { render, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import NodeWebSocket from "ws";

import { createDb } from "#renderer/data/db";
import { createQueryClient } from "#renderer/data/query-client";
import { bootstrap } from "#renderer/lib/bootstrap";
import { initI18n } from "#renderer/lib/i18n";
import { createAppRouter } from "#renderer/router";
import { loadUntyped } from "#renderer/test-support/chat-relay";

import { awaitWebSocketOpen, createWebSocketTransport } from "./websocket";
it("R8-T3 boots the browser shell against smoke:rpc --serve without denied calls", async () => {
  const { supportsProcedure } = await loadUntyped<{
    supportsProcedure(platform: "web-host", path: string): boolean;
  }>(
    new URL(
      "../../../../desktop/src/main/platform/capabilities.ts",
      import.meta.url
    ).pathname
  );
  const child = spawn(
    process.execPath,
    [
      resolve(
        import.meta.dirname,
        "../../../../desktop/scripts/rpc-ws-smoke.mjs"
      ),
      "--serve",
    ],
    { env: process.env }
  );
  let output = "";
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output)), 15_000);
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = /serving on (ws:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(output));
    });
  });
  const violations: string[] = [];
  const inspect = (path: string, error?: unknown) => {
    if (!supportsProcedure("web-host", path)) violations.push(path);
    if (
      ["FORBIDDEN", "UNSUPPORTED"].includes(
        (error as { code?: string } | undefined)?.code ?? ""
      )
    )
      violations.push(path + ":" + (error as { code: string }).code);
  };
  const socket = new NodeWebSocket(url) as unknown as WebSocket;
  let db: ReturnType<typeof createDb> | undefined;
  let unmount: (() => void) | undefined;
  const queryClient = createQueryClient();
  try {
    await awaitWebSocketOpen(socket);
    const transport = createWebSocketTransport(url, {
      WebSocket: class {
        constructor() {
          return socket;
        }
      } as unknown as typeof WebSocket,
      flowControl: false,
      inspectCall: inspect,
    });
    await initI18n();
    const result = await bootstrap({
      getTransport: async () => transport,
      queryClient,
      getDb: (value) => (db = createDb(async () => value)),
      onTransportLost: () => {},
    });
    if (!result.ok) throw result.error;
    const router = createAppRouter({
      context: { ...result.boot, t: (() => "") as never },
    });
    await router.navigate({ to: "/bots" });
    await router.load();
    const mounted = render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
    unmount = mounted.unmount;
    await waitFor(
      () =>
        expect(document.querySelector('[data-slot="shell"]')).not.toBeNull(),
      { timeout: 10_000 }
    );
    for (const to of [
      "/settings/appearance",
      "/settings/models",
      "/library/messaging",
      "/sessions",
      "/settings/account",
    ] as const) {
      await router.navigate({ to });
      await router.load();
    }
    expect(violations).toEqual([]);
  } finally {
    unmount?.();
    db?.stop();
    await queryClient.cancelQueries();
    queryClient.clear();
    if (db)
      await Promise.all(
        Object.values(db.collections).map((collection) => collection.cleanup())
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
    socket.close();
    child.kill("SIGTERM");
  }
}, 30_000);
