import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { Transport } from "#renderer/data/transport";
import {
  Markdown,
  MarkdownLinksProvider,
} from "#renderer/features/chat/markdown/markdown";
import { createConnectFlow } from "#renderer/features/library/connect-flow";
import { connectOnboarding } from "#renderer/features/onboarding/connect";
import { startFirstRunGmail } from "#renderer/features/onboarding/first-run";
import { ConnectAttempt } from "#renderer/lib/connect-page";
import { connectRequest } from "#renderer/lib/connector-requests";
import { connectTarget, platformSystem } from "#renderer/lib/platform-system";

const HOST = "https://apps.example/api/botHost/h1";
const signIn = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as const));
vi.mock("#platform/sign-in", () => ({ signInAbacus: signIn }));
vi.mock("#renderer/features/shell/connect/services", async (original) => ({
  ...(await original<object>()),
  browserConnection: () => ({ base: HOST }),
}));

const START_PAGE = window.location.href;
afterEach(() => {
  window.history.replaceState(null, "", START_PAGE);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document
    .querySelectorAll("#gmail-consent, #onboarding-consent")
    .forEach((el) => el.remove());
  localStorage.clear();
});

/** A client whose host announces status changes when the test says so. */
const clientFor = () => {
  let wake: (() => void) | null = null;
  let next:
    | { type: "status-changed" }
    | { type: "connect-failed"; connectorId: string } = {
    type: "status-changed",
  };
  const streams = { open: 0 };
  const client = {
    connectors: {
      connect: vi
        .fn()
        .mockResolvedValue({ ok: true, url: "https://apps.example/connect" }),
      statuses: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValue({ "abacus-gmailuser": { state: "connected" } }),
      respond: vi.fn().mockResolvedValue(undefined),
      cancelConnect: vi.fn().mockResolvedValue(undefined),
      events: vi.fn(
        async (_input: unknown, { signal }: { signal: AbortSignal }) => {
          streams.open += 1;
          signal.addEventListener("abort", () => (streams.open -= 1), {
            once: true,
          });
          return (async function* () {
            while (!signal.aborted) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
              wake = null;
              yield next;
              next = { type: "status-changed" };
            }
          })();
        }
      ),
    },
    system: {
      funnelStep: vi.fn().mockResolvedValue(undefined),
      openExternal: vi.fn(),
    },
    mcp: { refresh: vi.fn() },
  };
  /** The host announces a change, once the page's stream is listening. */
  const changed = async (): Promise<void> => {
    await vi.waitFor(() => expect(wake).not.toBeNull());
    wake!();
  };
  /** The host's page reports the connect for `connectorId` failed. */
  const failed = async (connectorId: string): Promise<void> => {
    await vi.waitFor(() => expect(wake).not.toBeNull());
    next = { type: "connect-failed", connectorId };
    wake!();
  };
  return { client, changed, failed, streams };
};
/** The open transport a connect follows the host's announcements on. */
const hostOf = (client: ReturnType<typeof clientFor>["client"]): Transport =>
  ({ client, state: "open" }) as unknown as Transport;
/** `window.open` that opens: a tab whose opener the app then cuts. */
const opening = () => vi.fn(() => ({ opener: window }) as unknown as Window);
const GMAIL_PAGE = "/chatllm/connect-connector?service=gmailuser&autostart=1";
const flowFor = (client: ReturnType<typeof clientFor>["client"]) =>
  createConnectFlow({
    transport: {
      ...hostOf(client),
      orpc: createTanstackQueryUtils(client as never),
    } as unknown as Transport,
    db: { collections: { sessions: { toArray: [] } } } as never,
    queryClient: new QueryClient(),
    navigate: async () => {},
  });

it("onboarding opens the connect page inside the click and succeeds only once the host says connected", async () => {
  const open = opening();
  vi.stubGlobal("open", open);
  const { client, changed } = clientFor();
  const pending = connectOnboarding(
    {} as never,
    hostOf(client),
    "abacus-gmailuser"
  );
  expect(open).toHaveBeenCalledExactlyOnceWith(GMAIL_PAGE, "_blank");
  expect(open.mock.results[0]!.value.opener).toBeNull();
  let complete = false;
  void pending.then(() => {
    complete = true;
  });
  // The first read happens at once.
  await vi.waitFor(() =>
    expect(client.connectors.statuses).toHaveBeenCalledOnce()
  );
  expect(complete).toBe(false);
  await changed();
  expect(await pending).toEqual({ ok: true });
  expect(client.connectors.statuses).toHaveBeenCalledTimes(2);
});

it("agent requests open the page synchronously and answer connected only once it is", async () => {
  const open = opening();
  vi.stubGlobal("open", open);
  const { client, changed } = clientFor();
  const pending = connectRequest(hostOf(client), {
    requestId: "request",
    connectorId: "abacus-gmailuser",
    conversationKey: "bot:bot-id",
  } as never);
  expect(open).toHaveBeenCalledExactlyOnceWith(GMAIL_PAGE, "_blank");
  await vi.waitFor(() =>
    expect(client.connectors.statuses).toHaveBeenCalledOnce()
  );
  expect(client.connectors.respond).not.toHaveBeenCalled();
  await changed();
  expect(await pending).toEqual({ kind: "connected" });
  expect(client.connectors.respond).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "connected" })
  );
});

it("cancelling an agent request's wait stops it, releases the stream, and leaves the answer to the caller", async () => {
  vi.stubGlobal("open", opening());
  const { client, streams } = clientFor();
  client.connectors.statuses.mockReset().mockResolvedValue({});
  const abort = new AbortController();
  const pending = connectRequest(
    hostOf(client),
    {
      requestId: "request",
      connectorId: "abacus-gmailuser",
      conversationKey: "bot:bot-id",
    } as never,
    undefined,
    abort.signal
  );
  await vi.waitFor(() => expect(streams.open).toBe(1));
  abort.abort();
  expect(await pending).toEqual({ kind: "declined" });
  expect(streams.open).toBe(0);
  expect(client.connectors.respond).not.toHaveBeenCalled();
});

it("a blocked pop-up is reported, and nothing is asked of the host", async () => {
  vi.stubGlobal(
    "open",
    vi.fn(() => null)
  );
  const { client } = clientFor();
  const attempt = new ConnectAttempt(hostOf(client), "abacus-gmailuser");
  expect(await attempt.result).toEqual({ ok: false, error: "popup-blocked" });
  expect(client.connectors.connect).not.toHaveBeenCalled();
});

it("one deadline: a wait gives up after three minutes, and re-reads on focus before that", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("open", opening());
  const { client, streams } = clientFor();
  client.connectors.statuses.mockReset().mockResolvedValue({});
  const attempt = new ConnectAttempt(hostOf(client), "notion");
  await vi.advanceTimersByTimeAsync(0);
  expect(client.connectors.statuses).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(client.connectors.statuses).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(180_000);
  expect(await attempt.result).toEqual({ ok: false, error: "timeout" });
  expect(streams.open).toBe(0);
});

it("first-run Gmail waits for a click, then for the connection; dismissing cancels the wait", async () => {
  const open = opening();
  vi.stubGlobal("open", open);
  const { client, changed, streams } = clientFor();
  client.connectors.statuses
    .mockReset()
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({})
    .mockResolvedValue({ "abacus-gmailuser": { state: "connected" } });
  const slot = document.createElement("div");
  slot.id = "onboarding-consent";
  document.body.append(slot);
  await startFirstRunGmail(hostOf(client), "owner@example.com");
  expect(open).not.toHaveBeenCalled();
  expect(slot.querySelector("#gmail-consent")?.className).not.toContain(
    "fixed"
  );
  (document.getElementById("gmail-consent") as HTMLButtonElement).click();
  expect(open).toHaveBeenCalledExactlyOnceWith(
    `${GMAIL_PAGE}&hint=owner%40example.com`,
    "_blank"
  );
  await vi.waitFor(() => expect(streams.open).toBe(1));
  expect(client.system.funnelStep).not.toHaveBeenCalled();
  await changed();
  await vi.waitFor(() =>
    expect(client.system.funnelStep).toHaveBeenCalledWith({
      step: "gmail_allowed",
    })
  );

  // Again, then dismissed mid-wait: the wait and its stream go with it.
  const second = clientFor();
  second.client.connectors.statuses.mockReset().mockResolvedValue({});
  await startFirstRunGmail(hostOf(second.client), "owner@example.com");
  (document.getElementById("gmail-consent") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(second.streams.open).toBe(1));
  (slot.querySelector("button:last-child") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(second.streams.open).toBe(0));
  expect(slot.children).toHaveLength(0);
});

it("library opens the page inside the click and settles once connected", async () => {
  const open = opening();
  vi.stubGlobal("open", open);
  const { client, changed } = clientFor();
  // The sign-in check reads once, then the wait reads at once.
  client.connectors.statuses
    .mockReset()
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({})
    .mockResolvedValue({ "abacus-gmailuser": { state: "connected" } });
  const flow = flowFor(client);
  const pending = flow.start("abacus-gmailuser");
  expect(open).toHaveBeenCalledExactlyOnceWith(GMAIL_PAGE, "_blank");
  await vi.waitFor(() => expect(flow.store.state.phase).toBe("waiting"));
  await vi.waitFor(() =>
    expect(client.connectors.statuses).toHaveBeenCalledTimes(2)
  );
  await changed();
  expect(await pending).toEqual({ ok: true });
  expect(flow.store.state.phase).toBe("idle");
});

it("library signs a signed-out host in first, explicitly, after the tab opened in the click", async () => {
  const open = opening();
  vi.stubGlobal("open", open);
  const { client, changed } = clientFor();
  client.connectors.statuses
    .mockReset()
    .mockResolvedValueOnce({
      "abacus-gmailuser": { state: "unavailable", reason: "not-signed-in" },
    })
    .mockResolvedValueOnce({})
    .mockResolvedValue({ "abacus-gmailuser": { state: "connected" } });
  const flow = flowFor(client);
  const pending = flow.start("abacus-gmailuser");
  expect(open).toHaveBeenCalledOnce();
  expect(signIn).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(client.connectors.connect).toHaveBeenCalled());
  // Signed in before the host was told to follow the page.
  expect(signIn.mock.invocationCallOrder[0]).toBeLessThan(
    client.connectors.connect.mock.invocationCallOrder[0]!
  );
  await vi.waitFor(() =>
    expect(client.connectors.statuses).toHaveBeenCalledTimes(2)
  );
  await changed();
  expect(await pending).toEqual({ ok: true });
});

it("library cancel stops waiting", async () => {
  vi.stubGlobal("open", opening());
  const { client, streams } = clientFor();
  client.connectors.statuses.mockReset().mockResolvedValue({});
  const flow = flowFor(client);
  const pending = flow.start("abacus-gmailuser");
  await vi.waitFor(() => expect(flow.store.state.phase).toBe("waiting"));
  await flow.cancel();
  expect(await pending).toMatchObject({ ok: false, cancelled: true });
  expect(flow.store.state.phase).toBe("idle");
  await vi.waitFor(() => expect(streams.open).toBe(0));
});

it("Gmail consent is dismissible and cannot survive leaving its layout slot", async () => {
  const slot = document.createElement("div");
  slot.id = "onboarding-consent";
  document.body.append(slot);
  const { client } = clientFor();
  client.connectors.statuses.mockReset().mockResolvedValue({});
  await startFirstRunGmail(hostOf(client), "owner@example.com");
  (slot.querySelector("button:last-child") as HTMLButtonElement).click();
  expect(slot.children).toHaveLength(0);
  await startFirstRunGmail(hostOf(client), "owner@example.com");
  slot.remove();
  expect(document.getElementById("gmail-consent")).toBeNull();
  await startFirstRunGmail(hostOf(client), "owner@example.com");
  expect(document.getElementById("gmail-consent")).toBeNull();
  expect(client.connectors.connect).not.toHaveBeenCalled();
});

/** This app's page at `path` (under its mount path), as the page the test is on. */
const onPage = (path: string): string => {
  const page = `${import.meta.env.BASE_URL}${path}`;
  window.history.replaceState(null, "", page);
  return page;
};
/** A host connect route that returns to `page`. */
const routeBackTo = (id: string, page: string) =>
  `${HOST}/mcp/connect/${id}?${new URLSearchParams({ return: page })}`;

it("decides in one place what each kind opens in the browser", () => {
  expect(connectTarget("abacus-gmailuser", "me@example.com")).toEqual({
    kind: "connect-page",
    url: `${GMAIL_PAGE}&hint=me%40example.com`,
  });
  // The route returns the tab to the page the click came from, without a
  // `connected` it was itself sent back with.
  const library = onPage("library/connectors");
  for (const id of ["notion", "huggingface"])
    expect(connectTarget(id)).toEqual({
      kind: "host-route",
      url: routeBackTo(id, library),
    });
  // The user's own server, by its name.
  const mcp = onPage("library/mcp?connected=mine");
  expect(connectTarget("my server")).toEqual({
    kind: "host-route",
    url: routeBackTo("my%20server", mcp.replace("?connected=mine", "")),
  });
  expect(connectTarget("messaging-whatsapp")).toEqual({ kind: "pairing" });
});

it.each([
  ["library", "notion"],
  ["agent request", "huggingface"],
])(
  "%s: an MCP connector opens the host's route inside the click and waits for its status",
  async (surface, id) => {
    const open = opening();
    vi.stubGlobal("open", open);
    const { client, changed } = clientFor();
    // From the Library, back to it; from a chat session, back to that chat.
    const page = onPage(
      surface === "library" ? "library/connectors" : "sessions/s-1?tab=files"
    );
    client.connectors.statuses
      .mockReset()
      .mockResolvedValueOnce({})
      .mockResolvedValue({ [id]: { state: "connected" } });
    const pending =
      surface === "library"
        ? flowFor(client).start(id)
        : connectRequest(hostOf(client), {
            requestId: "request",
            connectorId: id,
            conversationKey: "bot:bot-id",
          } as never);
    expect(open).toHaveBeenCalledExactlyOnceWith(
      routeBackTo(id, page),
      "_blank"
    );
    await vi.waitFor(() =>
      expect(client.connectors.statuses).toHaveBeenCalledOnce()
    );
    await changed();
    expect(await pending).toEqual(
      surface === "library" ? { ok: true } : { kind: "connected" }
    );
    // The route installs and signs in: nothing is asked over the socket.
    expect(client.connectors.connect).not.toHaveBeenCalled();
  }
);

it("a host connect link in a chat message returns to that chat; any other link opens as it is", async () => {
  const open = opening();
  vi.stubGlobal("open", open);
  const { client } = clientFor();
  const system = platformSystem(client as never);
  const chat = onPage("sessions/s-1?tab=files");
  render(
    <MarkdownLinksProvider
      value={{
        openFile: () => {},
        openExternal: (url) => void system.openExternal({ url }),
      }}
    >
      <Markdown
        content={`[Connect Notion](${HOST}/mcp/connect/notion) and [docs](https://example.com/docs)`}
        role="assistant"
        streaming={false}
        workspaceRoot="/repo"
      />
    </MarkdownLinksProvider>
  );
  fireEvent.click(screen.getByText("Connect Notion"));
  fireEvent.click(screen.getByText("docs"));
  await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  expect(open).toHaveBeenNthCalledWith(
    1,
    routeBackTo("notion", chat),
    "_blank",
    "noopener,noreferrer"
  );
  expect(open).toHaveBeenNthCalledWith(
    2,
    "https://example.com/docs",
    "_blank",
    "noopener,noreferrer"
  );
});

it("a connect the host reports failed ends at once, and only for its connector", async () => {
  vi.stubGlobal("open", opening());
  const { client, failed } = clientFor();
  client.connectors.statuses.mockReset().mockResolvedValue({});
  const attempt = new ConnectAttempt(hostOf(client), "notion");
  await failed("canva");
  await failed("notion");
  expect(await attempt.result).toEqual({ ok: false, error: "failed" });
});

it("cancel tells the host to drop the connect, once; a finished attempt asks nothing", async () => {
  vi.stubGlobal("open", opening());
  const { client, changed } = clientFor();
  client.connectors.statuses.mockReset().mockResolvedValue({});
  const attempt = new ConnectAttempt(hostOf(client), "notion");
  attempt.cancel();
  attempt.cancel();
  expect(await attempt.result).toMatchObject({ cancelled: true });
  expect(client.connectors.cancelConnect).toHaveBeenCalledExactlyOnceWith({
    connectorId: "notion",
  });
  const done = new ConnectAttempt(hostOf(client), "notion");
  client.connectors.statuses.mockResolvedValue({
    notion: { state: "connected" },
  });
  await changed();
  expect(await done.result).toEqual({ ok: true });
  done.cancel();
  expect(client.connectors.cancelConnect).toHaveBeenCalledOnce();
});
