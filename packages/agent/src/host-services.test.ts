/**
 * The host service client, which had no test and one very bad failure mode.
 *
 * Every request here is a promise a tool call is blocked on. Without a deadline
 * a request nobody answers is a tool call that never returns, and because a
 * pending promise keeps nothing on the event loop, the process did not even
 * hang visibly: `abacusai-bot "write me a report"` exited 0 with no output and
 * no JSON object, which a script reads as success.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostServiceClient } from "./host-services.js";
import type { HostService } from "./protocol.js";

interface Sent {
  requestId: string;
  service: HostService;
  payload: unknown;
}

function client(): { client: HostServiceClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const instance = new HostServiceClient((requestId, service, payload) => {
    sent.push({ requestId, service, payload });
  });

  return { client: instance, sent };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a request", () => {
  it("goes out with the payload and a fresh id", () => {
    const { client: instance, sent } = client();

    void instance.request("render_document", { html: "<p>hi</p>" });
    void instance.request("render_deck", { slides: [] });

    expect(sent).toHaveLength(2);
    expect(sent[0]?.service).toBe("render_document");
    expect(sent[0]?.payload).toEqual({ html: "<p>hi</p>" });
    expect(sent[0]?.requestId).not.toBe(sent[1]?.requestId);
  });

  it("resolves with what the host returned", async () => {
    const { client: instance, sent } = client();
    const pending = instance.request("document_templates", {});

    instance.settle(
      sent[0]!.requestId,
      true,
      { templates: ["plain"] },
      undefined
    );

    await expect(pending).resolves.toEqual({ templates: ["plain"] });
  });

  it("rejects with the reason the host gave", async () => {
    const { client: instance, sent } = client();
    const pending = instance.request("render_document", {});

    instance.settle(
      sent[0]!.requestId,
      false,
      undefined,
      "Chromium is not available."
    );

    await expect(pending).rejects.toThrow("Chromium is not available.");
  });

  it("rejects with something readable when the host gives no reason", async () => {
    const { client: instance, sent } = client();
    const pending = instance.request("render_document", {});

    instance.settle(sent[0]!.requestId, false, undefined, undefined);

    await expect(pending).rejects.toThrow(/no reason/i);
  });
});

describe("a request nobody answers", () => {
  it("rejects on its own rather than waiting forever", async () => {
    const { client: instance } = client();
    const pending = instance.request("render_document", {});
    const settled = vi.fn();

    void pending.then(settled, settled);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120_000);

    await expect(pending).rejects.toThrow(/did not answer/i);
  });

  it("names the service, so the failure says what was being waited on", async () => {
    const { client: instance } = client();
    const pending = instance.request("render_deck", {});

    void vi.advanceTimersByTimeAsync(200_000);

    await expect(pending).rejects.toThrow(/render_deck/);
  });

  it("does not hold the process open", () => {
    const { client: instance } = client();

    // Rejections are expected here; the assertion is about the timer.
    instance.request("render_document", {}).catch(() => undefined);

    // An unref'd timer is what lets Node exit while a request is outstanding;
    // a ref'd one would keep an idle CLI alive for the whole deadline.
    const timers = vi.getTimerCount();

    expect(timers).toBe(1);
  });
});

describe("an answer that arrives late", () => {
  it("is ignored, and does not resolve an already-rejected request", async () => {
    const { client: instance, sent } = client();
    const pending = instance.request("render_document", {});

    void vi.advanceTimersByTimeAsync(200_000);
    await expect(pending).rejects.toThrow();

    // Settling a request that has already timed out must be a no-op rather
    // than an unhandled resolve on a dead promise.
    expect(() =>
      instance.settle(sent[0]!.requestId, true, { ok: true }, undefined)
    ).not.toThrow();
  });

  it("is ignored for an id that was never issued", () => {
    const { client: instance } = client();

    expect(() =>
      instance.settle("host-does-not-exist", true, {}, undefined)
    ).not.toThrow();
  });
});

describe("failAll", () => {
  it("rejects everything outstanding with the reason given", async () => {
    const { client: instance } = client();
    const first = instance.request("render_document", {});
    const second = instance.request("render_deck", {});

    instance.failAll("Interrupted.");

    await expect(first).rejects.toThrow("Interrupted.");
    await expect(second).rejects.toThrow("Interrupted.");
  });

  it("clears the deadlines too, so nothing is left ticking", () => {
    const { client: instance } = client();

    instance.request("render_document", {}).catch(() => undefined);
    instance.request("render_deck", {}).catch(() => undefined);
    expect(vi.getTimerCount()).toBe(2);

    instance.failAll("Interrupted.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is safe with nothing outstanding", () => {
    const { client: instance } = client();

    expect(() => instance.failAll("Interrupted.")).not.toThrow();
  });
});
