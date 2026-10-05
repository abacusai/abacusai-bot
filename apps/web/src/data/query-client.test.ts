/**
 * The mutation policy lives on the client (spec 01 §8.2): `meta.invalidates`
 * refetches the named keys on success only, `meta.errorToast` reports a
 * failure by the site's policy (once per text), and `optimistic` keeps
 * pending writes applied over a baseline, rolls back only a failed one and
 * refetches once after the last.
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

import {
  createQueryClient,
  optimistic,
  PATCH_LIMIT_MS,
  succeeding,
} from "./query-client";

const showError = vi.fn();
const createClient = () => createQueryClient({ showError });

beforeEach(async () => {
  showError.mockReset();
  await initI18n();
});

type Client = ReturnType<typeof createClient>;
/** Past the toast coalescing window. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

it("toasts by the site's policy: a copy key, the error's message, main's reason or nothing", async () => {
  const client = createClient();
  const fail = () => Promise.reject(new Error("disk full"));
  const refuse = (error?: string) => async () => ({ success: false, error });
  await run(
    client,
    { mutationFn: fail, meta: { errorToast: "phase5.saveFailed" } },
    undefined
  );
  await tick();
  await run(
    client,
    { mutationFn: fail, meta: { errorToast: true } },
    undefined
  );
  await tick();
  await run(client, { mutationFn: fail }, undefined);
  await tick();
  // A copy key stays the copy even when main gave a reason.
  await run(
    client,
    succeeding({
      mutationFn: refuse("taken"),
      meta: { errorToast: "phase5.saveFailed" as const },
    }),
    undefined
  );
  await tick();
  const reason = { errorToast: { reasonOr: "phase5.failed" } };
  await run(
    client,
    succeeding({ mutationFn: refuse("locked"), meta: reason }),
    undefined
  );
  await tick();
  await run(
    client,
    succeeding({ mutationFn: refuse(), meta: reason }),
    undefined
  );
  await tick();
  await run(client, { mutationFn: fail, meta: reason }, undefined);
  expect(showError.mock.calls).toEqual([
    [enUS.phase5.saveFailed],
    ["disk full"],
    [enUS.phase5.saveFailed],
    ["locked"],
    [enUS.phase5.failed],
    [enUS.phase5.failed],
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

it("does not succeed on a cancelled answer", async () => {
  const client = createClient();
  const options = succeeding({
    mutationFn: async () => ({ success: false, cancelled: true }),
    meta: { errorToast: true as const },
  });
  expect(await run(client, options, undefined)).toBe("ok");
  expect(showError).not.toHaveBeenCalled();
});

/** A deferred mutationFn: `answers[i](ok)` settles the i-th call. */
const deferred = () => {
  const answers: Array<(ok: boolean) => void> = [];
  return {
    answers,
    mutationFn: () =>
      new Promise<void>((resolve, reject) =>
        answers.push((ok) => (ok ? resolve() : reject(new Error("no"))))
      ),
  };
};

type Flags = Record<string, boolean>;
const set =
  (field: string) =>
  (data: Flags, on: boolean): Flags => ({ ...data, [field]: on });

it("applies before the call, rolls back a failure, and refetches once after it", async () => {
  const client = createClient();
  const key = ["toggles"];
  const read = vi.fn(async () => ({ a: false }));
  const stop = await watch(client, key, read);
  read.mockClear();
  const call = deferred();
  const options = {
    mutationKey: ["toggle"],
    mutationFn: call.mutationFn,
    ...optimistic(key as never, set("a")),
  };
  const first = run(client, options, true);
  await vi.waitFor(() => expect(call.answers).toHaveLength(1));
  expect(client.getQueryData(key)).toEqual({ a: true });
  call.answers[0]!(false);
  expect(await first).toBe("failed");
  expect(client.getQueryData(key)).toEqual({ a: false });
  expect(read).toHaveBeenCalledTimes(1);
  stop();
});

it("two writes to different keys failing in the same task each roll back and refetch once", async () => {
  const client = createClient();
  const reads = {
    a: vi.fn(async () => ({ on: false })),
    b: vi.fn(async () => ({ on: false })),
  };
  const stops = [
    await watch(client, ["a"], reads.a),
    await watch(client, ["b"], reads.b),
  ];
  reads.a.mockClear();
  reads.b.mockClear();
  const call = deferred();
  const write = (key: string) => ({
    mutationKey: ["toggle"],
    mutationFn: call.mutationFn,
    meta: { errorToast: "phase5.failed" },
    ...optimistic([key] as never, set("on")),
  });
  const a = run(client, write("a"), true);
  const b = run(client, write("b"), true);
  await vi.waitFor(() => expect(call.answers).toHaveLength(2));
  // Rejected together, as revoked held writes are.
  call.answers[0]!(false);
  call.answers[1]!(false);
  expect(await Promise.all([a, b])).toEqual(["failed", "failed"]);
  expect(client.getQueryData(["a"])).toEqual({ on: false });
  expect(client.getQueryData(["b"])).toEqual({ on: false });
  expect(reads.a).toHaveBeenCalledTimes(1);
  expect(reads.b).toHaveBeenCalledTimes(1);
  // One toast for the same copy.
  expect(showError).toHaveBeenCalledTimes(1);
  for (const stop of stops) stop();
});

it("same-key writes: a failure removes only its own patch, whichever settles first", async () => {
  const client = createClient();
  const key = ["flags"];
  let server: Flags = { a: false, b: false };
  const read = vi.fn(async () => server);
  const stop = await watch(client, key, read);
  read.mockClear();
  const call = deferred();
  const write = (field: string) => ({
    mutationKey: ["flags"],
    mutationFn: call.mutationFn,
    ...optimistic(key as never, set(field)),
  });

  // A fails after B started: B stays applied.
  const a = run(client, write("a"), true);
  const b = run(client, write("b"), true);
  await vi.waitFor(() => expect(call.answers).toHaveLength(2));
  expect(client.getQueryData(key)).toEqual({ a: true, b: true });
  call.answers[0]!(false);
  expect(await a).toBe("failed");
  expect(client.getQueryData(key)).toEqual({ a: false, b: true });
  expect(read).not.toHaveBeenCalled();
  server = { a: false, b: true };
  call.answers[1]!(true);
  expect(await b).toBe("ok");
  expect(read).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(key)).toEqual({ a: false, b: true });

  // B fails after A succeeded: A stays applied, B's value does not return.
  read.mockClear();
  server = { a: false, b: false };
  const a2 = run(client, write("a"), true);
  const b2 = run(client, write("b"), true);
  await vi.waitFor(() => expect(call.answers).toHaveLength(4));
  call.answers[2]!(true);
  expect(await a2).toBe("ok");
  expect(client.getQueryData(key)).toEqual({ a: true, b: true });
  call.answers[3]!(false);
  expect(await b2).toBe("failed");
  expect(read).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(key)).toEqual({ a: false, b: false });
  stop();
});

it("a refetch landing while a write is pending becomes the baseline under it", async () => {
  const client = createClient();
  const key = ["flags"];
  let server: Flags = { a: false, b: false };
  const read = vi.fn(async () => server);
  const stop = await watch(client, key, read);
  const call = deferred();
  const write = run(
    client,
    {
      mutationKey: ["flags"],
      mutationFn: call.mutationFn,
      ...optimistic(key as never, set("a")),
    },
    true
  );
  await vi.waitFor(() => expect(call.answers).toHaveLength(1));
  // Something else changed `b`; a reconnect refetches before the write lands.
  server = { a: false, b: true };
  await client.refetchQueries({ queryKey: key });
  expect(client.getQueryData(key)).toEqual({ a: true, b: true });
  call.answers[0]!(false);
  expect(await write).toBe("failed");
  expect(client.getQueryData(key)).toEqual({ a: false, b: true });
  stop();
});

it("drops a patch whose write never settles after the limit, refetches once, and ignores its late answer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const client = createClient();
    const key = ["flags"];
    const read = vi.fn(async () => ({ a: false }));
    const stop = await watch(client, key, read);
    read.mockClear();
    const call = deferred();
    const write = run(
      client,
      {
        mutationKey: ["flags"],
        mutationFn: call.mutationFn,
        ...optimistic(key as never, set("a")),
      },
      true
    );
    await vi.waitFor(() => expect(call.answers).toHaveLength(1));
    expect(client.getQueryData(key)).toEqual({ a: true });
    // (vi.waitFor above advanced the fake clock a little.)
    await vi.advanceTimersByTimeAsync(PATCH_LIMIT_MS - 1000);
    expect(client.getQueryData(key)).toEqual({ a: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getQueryData(key)).toEqual({ a: false });
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    // The write answers at last: no second refetch, the value stays.
    call.answers[0]!(true);
    expect(await write).toBe("ok");
    await vi.advanceTimersByTimeAsync(10);
    expect(read).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(key)).toEqual({ a: false });
    stop();
  } finally {
    vi.useRealTimers();
  }
});
