import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Transport } from "#renderer/data/transport";
import type { AppClient } from "#renderer/data/transport/types";
import { createConnectFlow } from "#renderer/features/library/connect-flow";
import { connectOnboarding } from "#renderer/features/onboarding/connect";
import { startFirstRunGmail } from "#renderer/features/onboarding/first-run";
import { connectRequest } from "#renderer/lib/connector-requests";

import {
  completeConnectorAuthorization,
  reserveAuthorization,
} from "./authorization";
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document
    .querySelectorAll("dialog, #gmail-consent, #onboarding-consent")
    .forEach((el) => el.remove());
  localStorage.clear();
});
const clientFor = () => ({
  connectors: {
    connect: vi
      .fn()
      .mockResolvedValue({ ok: true, url: "https://consent.example/" }),
    statuses: vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValue({ "abacus-gmailuser": { state: "connected" } }),
    cancelConnect: vi.fn(),
    respond: vi.fn().mockResolvedValue(undefined),
  },
  system: { funnelStep: vi.fn().mockResolvedValue(undefined) },
  mcp: { refresh: vi.fn() },
});
it("reserves the popup before RPC completion and polls disconnected status before onboarding success", async () => {
  vi.useFakeTimers();
  const popup = {
    opener: window,
    closed: false,
    location: { href: "about:blank" },
    close: vi.fn(),
  };
  const open = vi.fn().mockReturnValue(popup);
  vi.stubGlobal("open", open);
  const client = clientFor();
  const pending = connectOnboarding(
    {} as never,
    { client } as unknown as Transport,
    "abacus-gmailuser"
  );
  expect(open).toHaveBeenCalledWith("about:blank", "_blank");
  expect(popup.opener).toBeNull();
  let complete = false;
  void pending.then(() => {
    complete = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(complete).toBe(false);
  expect(popup.location.href).toBe("https://consent.example/");
  await vi.advanceTimersByTimeAsync(3000);
  expect(await pending).toEqual({ ok: true });
  expect(client.connectors.statuses).toHaveBeenCalledTimes(2);
});
it("agent requests report connected only after consent and offer blocked-popup recovery", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("open", vi.fn().mockReturnValue(null));
  const client = clientFor();
  const pending = connectRequest(
    client as never,
    {
      requestId: "request",
      connectorId: "abacus-gmailuser",
      conversationKey: "bot:bot-id",
    } as never
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(document.querySelector("dialog a")?.textContent).toContain(
    "Popup blocked"
  );
  expect(client.connectors.respond).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3000);
  expect(await pending).toEqual({ kind: "connected" });
  expect(client.connectors.respond).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "connected" })
  );
});
it("first-run Gmail waits for an actionable click and confirmed authorization", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("open", vi.fn().mockReturnValue(null));
  const client = clientFor();
  client.connectors.statuses
    .mockReset()
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({})
    .mockResolvedValue({ "abacus-gmailuser": { state: "connected" } });
  const slot = document.createElement("div");
  slot.id = "onboarding-consent";
  document.body.append(slot);
  await startFirstRunGmail(
    { client } as unknown as Transport,
    "owner@example.com"
  );
  expect(client.connectors.connect).not.toHaveBeenCalled();
  expect(slot.querySelector("#gmail-consent")).not.toBeNull();
  expect(slot.querySelector("#gmail-consent")?.className).not.toContain(
    "fixed"
  );
  (document.getElementById("gmail-consent") as HTMLButtonElement).click();
  await vi.advanceTimersByTimeAsync(0);
  expect(client.system.funnelStep).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3000);
  expect(client.system.funnelStep).toHaveBeenCalledWith({
    step: "gmail_allowed",
  });
});
it("allows cancellation and bounds abandoned authorization polling", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("open", vi.fn().mockReturnValue(null));
  const client = clientFor();
  client.connectors.statuses.mockResolvedValue({});
  const pending = completeConnectorAuthorization(
    client as unknown as AppClient,
    "abacus-gmailuser",
    { ok: true, url: "https://consent.example/" },
    reserveAuthorization()
  );
  document
    .querySelector("dialog button")
    ?.dispatchEvent(new MouseEvent("click"));
  await vi.advanceTimersByTimeAsync(3000);
  expect(await pending).toMatchObject({ cancelled: true });
  const timeout = completeConnectorAuthorization(
    client as unknown as AppClient,
    "abacus-gmailuser",
    { ok: true, url: "https://consent.example/" },
    reserveAuthorization()
  );
  await vi.advanceTimersByTimeAsync(180_000);
  expect(await timeout).toMatchObject({
    ok: false,
    error: expect.stringContaining("timed out"),
  });
});

it("library waits for consent before settling and reserves its popup synchronously", async () => {
  vi.useFakeTimers();
  const open = vi.fn().mockReturnValue(null);
  vi.stubGlobal("open", open);
  const client = clientFor();
  client.connectors.statuses
    .mockReset()
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({})
    .mockResolvedValue({ "abacus-gmailuser": { state: "connected" } });
  const queryClient = new QueryClient();
  const flow = createConnectFlow({
    transport: {
      client,
      orpc: createTanstackQueryUtils(client),
    } as unknown as Transport,
    db: { collections: { sessions: { toArray: [] } } } as never,
    queryClient,
    navigate: async () => {},
  });
  const pending = flow.start("abacus-gmailuser");
  expect(open).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(0);
  expect(flow.store.state.phase).toBe("hop");
  await vi.advanceTimersByTimeAsync(3000);
  expect(await pending).toEqual({ ok: true });
  expect(flow.store.state.phase).toBe("idle");
  queryClient.clear();
});

it.each(["cancel", "supersede"])(
  "rejects %s during a pending status RPC",
  async (action) => {
    vi.stubGlobal("open", vi.fn().mockReturnValue(null));
    const client = clientFor();
    let resolveStatus!: (value: unknown) => void;
    client.connectors.statuses.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStatus = resolve;
        })
    );
    let current = true;
    const pending = completeConnectorAuthorization(
      client as unknown as AppClient,
      "abacus-gmailuser",
      { ok: true, url: "https://consent.example/" },
      reserveAuthorization(),
      () => current
    );
    expect(client.connectors.statuses).toHaveBeenCalledOnce();
    if (action === "cancel")
      (document.querySelector("dialog button") as HTMLButtonElement).click();
    else current = false;
    resolveStatus({ "abacus-gmailuser": { state: "connected" } });
    expect(await pending).toMatchObject({ ok: false, cancelled: true });
    expect(document.querySelector("dialog")).toBeNull();
  }
);

it("Gmail consent is dismissible and cannot survive leaving its layout slot", async () => {
  const slot = document.createElement("div");
  slot.id = "onboarding-consent";
  document.body.append(slot);
  const client = clientFor();
  client.connectors.statuses.mockResolvedValue({});
  await startFirstRunGmail(
    { client } as unknown as Transport,
    "owner@example.com"
  );
  (slot.querySelector("button:last-child") as HTMLButtonElement).click();
  expect(slot.children).toHaveLength(0);
  await startFirstRunGmail(
    { client } as unknown as Transport,
    "owner@example.com"
  );
  slot.remove();
  expect(document.getElementById("gmail-consent")).toBeNull();
  await startFirstRunGmail(
    { client } as unknown as Transport,
    "owner@example.com"
  );
  expect(document.getElementById("gmail-consent")).toBeNull();
  expect(client.connectors.connect).not.toHaveBeenCalled();
});
