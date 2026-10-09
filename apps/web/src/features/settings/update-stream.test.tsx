/**
 * The update status follows `update.events` for as long as it is shown: an
 * end or a transient error reopens it, however often; a replaced socket
 * reopens it at once; a closed transport stops it. One stream for every
 * consumer.
 */
import type { UpdateStatus } from "@abacus-ai/contract/update";
import { ORPCError } from "@orpc/client";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { createQueryClient } from "#renderer/data/query-client";

import { useUpdateStatus } from "./updates";

const app = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("#renderer/lib/use-app-context", async (original) => ({
  ...(await original<typeof import("#renderer/lib/use-app-context")>()),
  useAppContext: () => app.current,
}));

const status = (version: string): UpdateStatus => ({
  checking: false,
  available: true,
  downloading: false,
  downloaded: false,
  installing: false,
  error: null,
  progress: null,
  updateInfo: { version } as never,
  installStalled: false,
  criticalUpdate: false,
  failedPhase: null,
});

type Open = (signal: AbortSignal) => AsyncGenerator<UpdateStatus>;

/**
 * A transport whose n-th open runs `opens[n]` (the last one repeats);
 * `update.status` answers with an older status than the stream's.
 */
const setup = (opens: Open[], queryClient = createQueryClient()) => {
  const listeners = new Set<() => void>();
  const client = {
    update: {
      events: vi.fn(),
      status: vi.fn(async () => status("0")),
      // The hook builds its install and check mutations from these.
      install: vi.fn(),
      check: vi.fn(),
    },
  };
  const transport = {
    state: "open" as string,
    generation: 1,
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    client,
    orpc: createTanstackQueryUtils(client as never),
  };
  let n = 0;
  transport.client.update.events.mockImplementation(
    async (_input: unknown, { signal }: { signal: AbortSignal }) =>
      opens[Math.min(n++, opens.length - 1)]!(signal)
  );
  app.current = { transport, queryClient };
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const view = renderHook(
    () => [useUpdateStatus(), useUpdateStatus()] as const,
    { wrapper }
  );
  return {
    view,
    queryClient,
    wrapper,
    events: transport.client.update.events,
    install: transport.client.update.install,
    version: () => view.result.current[0].status?.updateInfo?.version,
    move: (state: string, generation = transport.generation) => {
      transport.state = state;
      transport.generation = generation;
      for (const listener of listeners) listener();
    },
  };
};

const hold = (signal: AbortSignal) =>
  new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true })
  );

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
});

it("reopens a stream that ended, with one stream for both consumers", async () => {
  const fake = setup([
    async function* () {
      yield status("1");
    },
    async function* (signal) {
      yield status("2");
      await hold(signal);
    },
  ]);
  unmount = fake.view.unmount;
  await waitFor(() => expect(fake.version()).toBe("1"));
  await waitFor(() => expect(fake.version()).toBe("2"), { timeout: 3_000 });
  expect(fake.view.result.current[1].status?.updateInfo?.version).toBe("2");
  expect(fake.events).toHaveBeenCalledTimes(2);
});

it("reopens after transient errors, past where a query retry gives up", async () => {
  const fail: Open = () => {
    throw new ORPCError("UNAVAILABLE", { defined: true });
  };
  const fake = setup([
    async function* () {
      yield status("1");
      throw new Error("socket hiccup");
    },
    fail,
    fail,
    fail,
    fail,
    async function* (signal) {
      yield status("2");
      await hold(signal);
    },
  ]);
  unmount = fake.view.unmount;
  await waitFor(() => expect(fake.version()).toBe("1"));
  await waitFor(() => expect(fake.version()).toBe("2"), { timeout: 9_000 });
  expect(fake.events).toHaveBeenCalledTimes(6);
}, 12_000);

it("reopens at once on a replacement socket", async () => {
  let drop!: () => void;
  const fake = setup([
    async function* (signal) {
      yield status("1");
      await Promise.race([
        hold(signal),
        new Promise<void>((resolve) => (drop = resolve)),
      ]);
      throw new Error("socket closed");
    },
    async function* (signal) {
      yield status("2");
      await hold(signal);
    },
  ]);
  unmount = fake.view.unmount;
  await waitFor(() => expect(fake.version()).toBe("1"));
  fake.move("connecting");
  drop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(fake.events).toHaveBeenCalledTimes(1);
  const reopened = Date.now();
  fake.move("open", 2);
  await waitFor(() => expect(fake.version()).toBe("2"));
  expect(Date.now() - reopened).toBeLessThan(900);
});

it("stops on a closed transport and on a final code, keeping the last status", async () => {
  let drop!: () => void;
  const fake = setup([
    async function* (signal) {
      yield status("1");
      await Promise.race([
        hold(signal),
        new Promise<void>((resolve) => (drop = resolve)),
      ]);
      throw new Error("socket closed");
    },
  ]);
  unmount = fake.view.unmount;
  await waitFor(() => expect(fake.version()).toBe("1"));
  fake.move("closed");
  drop();
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(fake.events).toHaveBeenCalledTimes(1);
  expect(fake.version()).toBe("1");

  unmount();
  const forbidden = setup([
    () => {
      throw new ORPCError("FORBIDDEN");
    },
  ]);
  unmount = forbidden.view.unmount;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  expect(forbidden.events).toHaveBeenCalledTimes(1);
  // The stream stopped for good; the status is the seed `update.status` read.
  expect(forbidden.version()).toBe("0");
});

it("settles, so an awaited invalidation of everything resolves while it follows", async () => {
  const fake = setup([
    async function* (signal) {
      yield status("1");
      await hold(signal);
    },
  ]);
  unmount = fake.view.unmount;
  await waitFor(() => expect(fake.version()).toBe("1"));
  const done = vi.fn();
  void fake.queryClient.invalidateQueries().then(done);
  await waitFor(() => expect(done).toHaveBeenCalled(), { timeout: 1_000 });
  // The refetch is `update.status`; the stream stays the one opened.
  expect(fake.events).toHaveBeenCalledTimes(1);
});

it("follows again after every consumer unmounted and one mounts again", async () => {
  const fake = setup([
    async function* (signal) {
      yield status("1");
      await hold(signal);
    },
    async function* (signal) {
      yield status("2");
      await hold(signal);
    },
  ]);
  await waitFor(() => expect(fake.version()).toBe("1"));
  fake.view.unmount();
  const again = renderHook(() => useUpdateStatus(), { wrapper: fake.wrapper });
  unmount = again.unmount;
  await waitFor(() =>
    expect(again.result.current.status?.updateInfo?.version).toBe("2")
  );
  expect(fake.events).toHaveBeenCalledTimes(2);
});

it("disables every update placement while the install request is pending", async () => {
  let checking!: () => void;
  const fake = setup([
    async function* (signal) {
      yield { ...status("2"), downloaded: true };
      await new Promise<void>((resolve) => {
        checking = resolve;
      });
      yield { ...status("2"), downloaded: true, checking: true };
      await hold(signal);
    },
  ]);
  unmount = fake.view.unmount;
  await waitFor(() => expect(fake.version()).toBe("2"));
  let reject!: (error: Error) => void;
  fake.install.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      })
  );
  act(() => fake.view.result.current[0].install());
  await waitFor(() =>
    expect(fake.view.result.current.map((update) => update.phase)).toEqual([
      "installing",
      "installing",
    ])
  );
  act(() => checking());
  await waitFor(() =>
    expect(fake.view.result.current[1].status?.checking).toBe(true)
  );
  expect(fake.view.result.current.map((update) => update.phase)).toEqual([
    "installing",
    "installing",
  ]);
  act(() => reject(new Error("Install request failed")));
  await waitFor(() =>
    expect(fake.view.result.current[0].phase).toBe("installFailed")
  );
  expect(fake.view.result.current[1].clicked).toBe(false);
  expect(fake.events).toHaveBeenCalledTimes(1);
});

it("shows a new handoff error without re-enabling install while the native watchdog runs", async () => {
  const fake = setup([
    async function* (signal) {
      yield {
        ...status("2"),
        downloaded: true,
        installing: true,
        error: "signature mismatch",
        failedPhase: "install",
      };
      await hold(signal);
    },
  ]);
  unmount = fake.view.unmount;
  await waitFor(() => expect(fake.version()).toBe("2"));
  expect(fake.view.result.current[0].status?.error).toBe("signature mismatch");
  expect(fake.view.result.current[0].phase).toBe("installing");
});
