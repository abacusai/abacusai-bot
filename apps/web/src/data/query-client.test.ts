/**
 * The mutation policy lives on the client (spec 01 §8.2): `meta.invalidates`
 * refetches the named keys on success only, `meta.errorToast` reports a
 * failure once.
 */
import {
  CancelledError,
  MutationObserver,
  QueryObserver,
  type MutationObserverOptions,
  type QueryKey,
} from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { hostUnavailable } from "#renderer/data/transport/lifecycle";
import { initI18n } from "#renderer/lib/i18n";

import { createQueryClient } from "./query-client";

const showError = vi.fn();
const createClient = () => createQueryClient({ showError });

beforeEach(async () => {
  showError.mockReset();
  await initI18n();
});

type Client = ReturnType<typeof createClient>;

const run = <Variables, Result>(
  client: Client,
  options: MutationObserverOptions<unknown, Error, Variables, Result>,
  variables: Variables
): Promise<"ok" | "failed"> =>
  new MutationObserver(client, options).mutate(variables).then(
    () => "ok",
    () => "failed"
  );

/** An observed query, so invalidation refetches it. */
const watch = async <Data>(
  client: Client,
  queryKey: QueryKey,
  queryFn: () => Promise<Data>
) => {
  const observer = new QueryObserver(client, { queryKey, queryFn });
  const stop = observer.subscribe(() => {});
  await vi.waitFor(() =>
    expect(client.getQueryState(queryKey)?.status).toBe("success")
  );
  return stop;
};

it("refetches the keys a mutation names once it succeeds, not when it fails", async () => {
  const client = createClient();
  const readA = vi.fn(async () => 1);
  const readB = vi.fn(async () => 2);
  const stops = [
    await watch(client, ["a", 1], readA),
    await watch(client, ["b"], readB),
  ];
  readA.mockClear();
  readB.mockClear();
  const meta = { invalidates: [["a"]] };
  expect(
    await run(client, { mutationFn: async () => {}, meta }, undefined)
  ).toBe("ok");
  expect(readA).toHaveBeenCalledTimes(1);
  expect(readB).not.toHaveBeenCalled();
  readA.mockClear();
  const fail = () => Promise.reject(new Error("no"));
  expect(await run(client, { mutationFn: fail, meta }, undefined)).toBe(
    "failed"
  );
  expect(readA).not.toHaveBeenCalled();
  for (const stop of stops) stop();
});

it("toasts a failure by copy key, by the error's message, or not at all", async () => {
  const client = createClient();
  const fail = () => Promise.reject(new Error("disk full"));
  await run(
    client,
    { mutationFn: fail, meta: { errorToast: "phase5.saveFailed" } },
    undefined
  );
  await run(
    client,
    { mutationFn: fail, meta: { errorToast: true } },
    undefined
  );
  await run(client, { mutationFn: fail }, undefined);
  expect(showError.mock.calls).toEqual([
    [enUS.phase5.saveFailed],
    ["disk full"],
  ]);
});

it("does not toast an aborted or cancelled mutation, and toasts a write that was never sent as not sent", async () => {
  const client = createClient();
  const meta = { errorToast: true as const };
  await run(
    client,
    {
      mutationFn: () =>
        Promise.reject(new DOMException("The user aborted", "AbortError")),
      meta,
    },
    undefined
  );
  await run(
    client,
    { mutationFn: () => Promise.reject(new CancelledError()), meta },
    undefined
  );
  await run(
    client,
    {
      mutationFn: () => Promise.reject(hostUnavailable("nothing was sent")),
      meta,
    },
    undefined
  );
  expect(showError.mock.calls).toEqual([[enUS.chat.message.notSent]]);
});
