import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";

import type { Transport } from "#renderer/data/transport";
import { createConnectFlow } from "#renderer/features/library/connect-flow";
import { connectOnboarding } from "#renderer/features/onboarding/connect";
import { startFirstRunGmail } from "#renderer/features/onboarding/first-run";
import { waitForConnected } from "#renderer/lib/connect-page";
import { connectRequest } from "#renderer/lib/connector-requests";
import { connectTarget } from "#renderer/lib/platform-system";

const HOST = "https://apps.example/api/botHost/h1";
vi.mock("#renderer/features/shell/connect/services", async (original) => ({
  ...(await original<object>()),
  browserConnection: () => ({ base: HOST }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document
    .querySelectorAll("#gmail-consent, #onboarding-consent")
    .forEach((el) => el.remove());
  localStorage.clear();
});
const clientFor = () => ({
  connectors: {
    connect: vi
      .fn()
      .mockResolvedValue({ ok: true, url: "https://apps.example/connect" }),
    statuses: vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValue({ "abacus-gmailuser": { state: "connected" } }),
    respond: vi.fn().mockResolvedValue(undefined),
  },
  system: { funnelStep: vi.fn().mockResolvedValue(undefined) },
  mcp: { refresh: vi.fn() },
});
const GMAIL_PAGE = "/chatllm/connect-connector?service=gmailuser&autostart=1";

it("onboarding opens the connect page inside the click and succeeds only once connected", async () => {
  vi.useFakeTimers();
  const open = vi.fn().mockReturnValue(null);
  vi.stubGlobal("open", open);
  const client = clientFor();
  const pending = connectOnboarding(
    {} as never,
    { client } as unknown as Transport,
    "abacus-gmailuser"
  );
  expect(open).toHaveBeenCalledExactlyOnceWith(
    GMAIL_PAGE,
    "_blank",
    "noopener"
  );
  let complete = false;
  void pending.then(() => {
    complete = true;
  });
  await vi.advanceTimersByTimeAsync(3000);
  expect(complete).toBe(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await pending).toEqual({ ok: true });
  expect(client.connectors.statuses).toHaveBeenCalledTimes(2);
});

it("agent requests open the page synchronously and answer connected only once it is", async () => {
  vi.useFakeTimers();
  const open = vi.fn().mockReturnValue(null);
  vi.stubGlobal("open", open);
  const client = clientFor();
  const pending = connectRequest(
    client as never,
    {
      requestId: "request",
      connectorId: "abacus-gmailuser",
      conversationKey: "bot:bot-id",
    } as never
  );
  expect(open).toHaveBeenCalledExactlyOnceWith(
    GMAIL_PAGE,
    "_blank",
    "noopener"
  );
  await vi.advanceTimersByTimeAsync(3000);
  expect(client.connectors.respond).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3000);
  expect(await pending).toEqual({ kind: "connected" });
  expect(client.connectors.respond).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "connected" })
  );
});

it("stopping an agent request's wait answers declined", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("open", vi.fn().mockReturnValue(null));
  const client = clientFor();
  client.connectors.statuses.mockReset().mockResolvedValue({});
  const abort = new AbortController();
  const pending = connectRequest(
    client as never,
    {
      requestId: "request",
      connectorId: "abacus-gmailuser",
      conversationKey: "bot:bot-id",
    } as never,
    undefined,
    abort.signal
  );
  await vi.advanceTimersByTimeAsync(3000);
  abort.abort();
  expect(await pending).toEqual({ kind: "declined" });
  expect(client.connectors.respond).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "declined" })
  );
});

it("first-run Gmail waits for a click, then for the connection", async () => {
  vi.useFakeTimers();
  const open = vi.fn().mockReturnValue(null);
  vi.stubGlobal("open", open);
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
  expect(open).not.toHaveBeenCalled();
  expect(slot.querySelector("#gmail-consent")).not.toBeNull();
  expect(slot.querySelector("#gmail-consent")?.className).not.toContain(
    "fixed"
  );
  (document.getElementById("gmail-consent") as HTMLButtonElement).click();
  expect(open).toHaveBeenCalledExactlyOnceWith(
    `${GMAIL_PAGE}&hint=owner%40example.com`,
    "_blank",
    "noopener"
  );
  await vi.advanceTimersByTimeAsync(3000);
  expect(client.system.funnelStep).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(3000);
  expect(client.system.funnelStep).toHaveBeenCalledWith({
    step: "gmail_allowed",
  });
});

it("waiting checks again on focus, stops when aborted and gives up after three minutes", async () => {
  vi.useFakeTimers();
  const client = clientFor();
  client.connectors.statuses.mockReset().mockResolvedValue({});
  const abort = new AbortController();
  const cancelled = waitForConnected(
    client as never,
    "abacus-gmailuser",
    abort.signal
  );
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(client.connectors.statuses).toHaveBeenCalledOnce();
  abort.abort();
  expect(await cancelled).toMatchObject({ ok: false, cancelled: true });
  const timeout = waitForConnected(
    client as never,
    "abacus-gmailuser",
    new AbortController().signal
  );
  await vi.advanceTimersByTimeAsync(183_000);
  expect(await timeout).toMatchObject({
    ok: false,
    error: expect.stringContaining("timed out"),
  });
});

it("library opens the page inside the click and settles once connected", async () => {
  vi.useFakeTimers();
  const open = vi.fn().mockReturnValue(null);
  vi.stubGlobal("open", open);
  const client = clientFor();
  client.connectors.statuses
    .mockReset()
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
  expect(open).toHaveBeenCalledExactlyOnceWith(
    GMAIL_PAGE,
    "_blank",
    "noopener"
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(flow.store.state.phase).toBe("waiting");
  await vi.advanceTimersByTimeAsync(6000);
  expect(await pending).toEqual({ ok: true });
  expect(flow.store.state.phase).toBe("idle");
  queryClient.clear();
});

it("library cancel stops waiting", async () => {
  vi.stubGlobal("open", vi.fn().mockReturnValue(null));
  const client = clientFor();
  client.connectors.statuses.mockReset().mockResolvedValue({});
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
  await vi.waitFor(() => expect(flow.store.state.phase).toBe("waiting"));
  await flow.cancel();
  expect(await pending).toMatchObject({ ok: false, cancelled: true });
  expect(flow.store.state.phase).toBe("idle");
  queryClient.clear();
});

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

it("decides in one place what each kind opens in the browser", () => {
  expect(connectTarget("abacus-gmailuser", "me@example.com")).toEqual({
    kind: "connect-page",
    url: `${GMAIL_PAGE}&hint=me%40example.com`,
  });
  for (const id of ["notion", "huggingface"])
    expect(connectTarget(id)).toEqual({
      kind: "host-route",
      url: `${HOST}/mcp/connect/${id}`,
    });
  // The user's own server, by its name.
  expect(connectTarget("my server")).toEqual({
    kind: "host-route",
    url: `${HOST}/mcp/connect/my%20server`,
  });
  expect(connectTarget("messaging-whatsapp")).toEqual({ kind: "pairing" });
});

it.each([
  ["library", "notion"],
  ["agent request", "huggingface"],
])(
  "%s: an MCP connector opens the host's route inside the click and waits for its status",
  async (surface, id) => {
    vi.useFakeTimers();
    const open = vi.fn().mockReturnValue(null);
    vi.stubGlobal("open", open);
    const client = clientFor();
    client.connectors.statuses
      .mockReset()
      .mockResolvedValueOnce({})
      .mockResolvedValue({ [id]: { state: "connected" } });
    const queryClient = new QueryClient();
    const pending =
      surface === "library"
        ? createConnectFlow({
            transport: {
              client,
              orpc: createTanstackQueryUtils(client),
            } as unknown as Transport,
            db: { collections: { sessions: { toArray: [] } } } as never,
            queryClient,
            navigate: async () => {},
          }).start(id)
        : connectRequest(
            client as never,
            {
              requestId: "request",
              connectorId: id,
              conversationKey: "bot:bot-id",
            } as never
          );
    expect(open).toHaveBeenCalledExactlyOnceWith(
      `${HOST}/mcp/connect/${id}`,
      "_blank",
      "noopener"
    );
    await vi.advanceTimersByTimeAsync(6000);
    expect(await pending).toEqual(
      surface === "library" ? { ok: true } : { kind: "connected" }
    );
    // The route installs and signs in: nothing is asked over the socket.
    expect(client.connectors.connect).not.toHaveBeenCalled();
    queryClient.clear();
  }
);
