/**
 * What an abandoned sign-in does, and what the next one does after it.
 *
 * The common way these flows fail is not an error: the browser opens and
 * nothing ever comes back to the loopback listener. Every flow waits twenty
 * minutes now. Sign-up is the app's mandatory front door, and account
 * creation, consent screens and 2FA have each outrun every shorter window
 * someone thought was generous. The
 * half worth testing is what happens next: the attempt has to leave nothing
 * behind, so pressing Connect again starts a clean one on a fresh port.
 */
import { shell } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: { openExternal: vi.fn() } }));

const openExternal = vi.mocked(shell.openExternal);

const { startAbacusAuth, cancelAbacusAuth } =
  await import("./abacus-auth-service");
const { startOpenRouterAuth, cancelOpenRouterAuth } =
  await import("./openrouter-auth-service");

/** The loopback port an attempt told the browser to come back to. */
const portFromLastCall = (): string => {
  const url = new URL(openExternal.mock.calls.at(-1)?.[0] ?? "");

  return (
    url.searchParams.get("botPort") ??
    new URL(url.searchParams.get("callback_url") ?? "http://x:0").port
  );
};

const FLOWS = [
  {
    name: "Abacus.AI",
    start: startAbacusAuth,
    cancel: cancelAbacusAuth,
    timeoutMs: 20 * 60 * 1000,
  },
  {
    name: "OpenRouter",
    start: startOpenRouterAuth,
    cancel: cancelOpenRouterAuth,
    timeoutMs: 20 * 60 * 1000,
  },
] as const;

beforeEach(() => {
  vi.useFakeTimers();
  openExternal.mockReset();
  openExternal.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  for (const flow of FLOWS) flow.cancel();
});

describe.each(FLOWS)("an unanswered $name sign-in", (flow) => {
  it("gives up after its window rather than a session", async () => {
    const attempt = flow.start();

    // Just before: still waiting, because the browser hop is legitimately slow.
    await vi.advanceTimersByTimeAsync(flow.timeoutMs - 1_000);

    let settled = false;

    void attempt.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);

    const result = await attempt;

    expect(result.ok).toBe(false);
    // The cause is in the browser, so the message has to point there.
    expect(result.ok === false && result.error).toMatch(/press Connect again/i);
  }, 20_000);

  it("leaves nothing behind, so the next press is a clean attempt", async () => {
    const first = flow.start();

    await vi.advanceTimersByTimeAsync(flow.timeoutMs + 1_000);
    await first;

    const firstPort = portFromLastCall();
    const second = flow.start();

    await vi.advanceTimersByTimeAsync(0);

    const secondPort = portFromLastCall();

    // A fresh listener: the timed-out one released its port, and this attempt
    // is waiting on its own rather than inheriting a closed socket.
    expect(secondPort).not.toBe("");
    expect(secondPort).not.toBe(firstPort);

    flow.cancel();

    const result = await second;

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.cancelled).toBe(true);
  }, 20_000);
});
