import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { AppClient } from "#renderer/data/transport/types";

import {
  resetPaymentConfirmWatch,
  usePaymentRecheck,
} from "./payment-confirming";

afterEach(() => {
  resetPaymentConfirmWatch();
  vi.useRealTimers();
});

const clientWith = (payment: () => unknown) =>
  ({
    account: { payment: vi.fn(async () => payment()) },
  }) as unknown as AppClient & {
    account: { payment: ReturnType<typeof vi.fn> };
  };

const Listeners = ({
  client,
  keys,
  heard = () => {},
}: {
  client: AppClient;
  keys: string[];
  heard?: (key: string, verdict: unknown) => void;
}) => (
  <>
    {keys.map((key) => (
      <Listener key={key} client={client} name={key} heard={heard} />
    ))}
  </>
);
const Listener = ({
  client,
  name,
  heard,
}: {
  client: AppClient;
  name: string;
  heard: (key: string, verdict: unknown) => void;
}) => {
  usePaymentRecheck(client, name, (verdict) => heard(name, verdict));
  return null;
};

const CARDS_AND_SCREEN = [
  "run:r1",
  "run:r2",
  "run:r3",
  "run:r4",
  "run:r5",
  "screen",
];

it("five no-plan cards and the screen share one account read per tick, and every one hears it", async () => {
  vi.useFakeTimers();
  const client = clientWith(() => ({ reason: "not_subscribed" }));
  const heard = vi.fn();
  render(<Listeners client={client} keys={CARDS_AND_SCREEN} heard={heard} />);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(client.account.payment).toHaveBeenCalledTimes(1);
  expect(heard).toHaveBeenCalledTimes(CARDS_AND_SCREEN.length);
  await vi.advanceTimersByTimeAsync(5_000 * 4);
  expect(client.account.payment).toHaveBeenCalledTimes(5);
  // A focus is one read too, not one per listener.
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(client.account.payment).toHaveBeenCalledTimes(6);
});

it("a remount does not restart the 30 minutes; a new refusal does", async () => {
  vi.useFakeTimers();
  const client = clientWith(() => ({ reason: "not_subscribed" }));
  const first = render(
    <Listeners client={client} keys={["run:r1", "run:r2"]} />
  );
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  // The scroller drops and brings back both cards.
  first.unmount();
  const again = render(
    <Listeners client={client} keys={["run:r1", "run:r2"]} />
  );
  await vi.advanceTimersByTimeAsync(11 * 60_000);
  const atLimit = client.account.payment.mock.calls.length;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(client.account.payment).toHaveBeenCalledTimes(atLimit);
  // A new refused turn opens a fresh window.
  again.rerender(
    <Listeners client={client} keys={["run:r1", "run:r2", "run:r3"]} />
  );
  await vi.advanceTimersByTimeAsync(5_000);
  expect(client.account.payment).toHaveBeenCalledTimes(atLimit + 1);
});

it("stops once the payment lands or is held, and a remount does not start it again", async () => {
  vi.useFakeTimers();
  let verdict: unknown = { reason: "not_subscribed" };
  const client = clientWith(() => verdict);
  const view = render(<Listeners client={client} keys={["run:r1"]} />);
  verdict = null;
  await vi.advanceTimersByTimeAsync(5_000);
  view.unmount();
  render(<Listeners client={client} keys={["run:r1"]} />);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(client.account.payment).toHaveBeenCalledTimes(1);
});

it("stops when nobody listens", async () => {
  vi.useFakeTimers();
  const client = clientWith(() => ({ reason: "not_subscribed" }));
  const view = render(<Listeners client={client} keys={["screen"]} />);
  await vi.advanceTimersByTimeAsync(5_000);
  view.unmount();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(client.account.payment).toHaveBeenCalledTimes(1);
});
