import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import {
  render,
  waitFor,
  act,
  fireEvent,
  screen,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";
import NodeWebSocket from "ws";

import { createDb } from "#renderer/data/db";
import { createQueryClient } from "#renderer/data/query-client";
import { bootstrap } from "#renderer/lib/bootstrap";
import { initI18n } from "#renderer/lib/i18n";
import { createAppRouter } from "#renderer/router";

import { awaitWebSocketOpen, createWebSocketTransport } from "./websocket";
it("R8-T3 boots the browser shell against smoke:rpc --serve without denied calls", async () => {
  // Read the native host policy outside Vite's deliberately browser-only graph.
  const { supportsProcedure } = createRequire(import.meta.url)(
    resolve(
      import.meta.dirname,
      "../../../../desktop/src/main/platform/capabilities.ts"
    )
  ) as { supportsProcedure(platform: "web-host", path: string): boolean };
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
  vi.stubEnv("VITE_WEB_HOST_URL", url);
  const { resolveBrowserHost } =
    await import("#renderer/features/shell/connect/services");
  const host = await resolveBrowserHost(() => {});
  const socket = new NodeWebSocket(host.url, [
    "abacus-rpc",
    `abacus-token.${host.token}`,
  ]) as unknown as WebSocket;
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
    (globalThis as Record<symbol, unknown>)[Symbol.for("abacus.transport")] =
      Promise.resolve(transport);
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
    const visit = async (to: string, landmark: string) => {
      await act(async () => {
        await router.navigate({ to });
        await router.load();
      });
      await waitFor(
        () =>
          expect(
            document.querySelector(landmark),
            `${to}: ${landmark}`
          ).not.toBeNull(),
        { timeout: 5000 }
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(violations).toEqual([]);
    };
    await visit("/settings/appearance", '[data-setting-id="theme"]');
    await visit(
      "/settings/models",
      'input[aria-label="Search model providers…"]'
    );
    await visit("/library/messaging", '[data-setting-id="gatewayEnabled"]');
    await act(async () => {
      await router.navigate({
        to: "/library/messaging",
        search: { platform: "abacus_telegram" },
      });
      await router.load();
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="sheet-content"]')
      ).not.toBeNull()
    );
    expect(screen.queryByText("Open login")).toBeNull();
    await visit("/sessions", '[data-slot="sessions-start"]');
    await visit("/routines/new", "form");
    await visit("/settings/account", "main h2");
    expect(
      await screen.findByRole("heading", { name: "Account" })
    ).toBeDefined();
    const search = screen.getByRole("textbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "local" } });
    expect(document.querySelector('a[href*="provider=local"]')).toBeNull();
    await visit("/bots", '[data-slot="shell"]');
    const { startTour, tourSignedOut } =
      await import("#renderer/features/tour/store");
    await act(async () => startTour({ origin: "/bots", onboarded: true }));
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(violations).toEqual([]);
    tourSignedOut();
    await visit("/onboarding/welcome", "h1");
    document
      .querySelector("h1")!
      .dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
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
    delete (globalThis as Record<symbol, unknown>)[
      Symbol.for("abacus.transport")
    ];
    vi.unstubAllEnvs();
  }
}, 30_000);
