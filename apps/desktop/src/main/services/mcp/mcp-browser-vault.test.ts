/**
 * `browser_vault_fill` and the vault's tools, driven over the real MCP
 * transport into the real `McpBrowserServer`. The page is a scripted CDP
 * responder and the platform a scripted fetch that spends each card field
 * once; what is checked is where the value goes (only into
 * `Input.insertText`, into the planned field), what the fill is told (the
 * live origins and the page's own total, never an argument), and that the
 * Abacus.AI's own pages are never opened.
 */
import os from "os";
import path from "path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  frameSnapshotScript,
  SNAPSHOT_BUILD_JS,
} from "../browser/browser-snapshot";
import { framePageOf, type BrowserPage } from "../browser/browser-target";
import {
  FIND_SECRET_FIELDS_SCRIPT,
  SecretFields,
} from "../browser/secret-fields";
import {
  DOCUMENT_INPUT_FACTS_SCRIPT,
  factsFromDocument,
} from "../vault/vault-fill";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
}));
const hostEvents: unknown[] = [];
vi.mock("#main/rpc/emit", () => ({
  emitHostEvent: (payload: unknown) => {
    hostEvents.push(payload);
  },
}));

const SECRET = "Pa55-w0rd-never-seen";
const CARD = "4242424242424242";
const CHECKOUT = "https://www.shop.example/checkout";

/** Every CDP command sent anywhere, with the document it went to. */
const commands: Array<{
  target: string;
  method: string;
  params: Record<string, unknown>;
}> = [];

const SNAPSHOT = {
  title: "Checkout",
  url: CHECKOUT,
  tree: {
    tag: "main",
    children: [
      { ref: "@e1", selector: "#password", tag: "input", type: "password" },
      { ref: "@e2", selector: "#card", tag: "input", name: "Card number" },
      { ref: "@e3", selector: "#total", tag: "span", name: "Total" },
      { ref: "@e4", selector: "#help", tag: "a", name: "Approve" },
      { ref: "@e5", selector: "#q", tag: "input", type: "search" },
    ],
  },
  refCount: 5,
  visibleCount: 5,
  offscreenCount: 0,
};

const FRAME_SNAPSHOT = {
  tree: {
    tag: "body",
    children: [
      {
        ref: "@f1e1",
        selector: "input[name=cardnumber]",
        tag: "input",
        name: "Card number",
      },
    ],
  },
};

/** The page as the scripted documents report it; tests move it. */
const page = {
  url: CHECKOUT,
  /** The live origins the browser reports when asked. */
  top: "https://www.shop.example" as string | null,
  frame: "https://js.stripe.com" as string | null,
  /** What each document says about itself in the arm check right before typing. */
  armOrigin: {} as Record<string, string>,
  focusedAtArm: true,
  focusedAfterTyping: true,
  totalText: "Total ₹1,234.00",
  linkHref: null as string | null,
  loads: [] as string[],
  /** Each document's inputs as the page declares them, by selector. */
  fields: {} as Record<
    string,
    Record<string, { id: number; attributes: string[] }>
  >,
  /** Attributes a field has now in place of those it was first seen with. */
  liveAttributes: {} as Record<string, string[]>,
  /** Set to make the browser refuse to block loads. */
  refuseBlock: false,
  /** Child frames the page's own frame tree lists. */
  treeFrames: [] as string[],
  /** The main document's loader: a new one is a new document. */
  loader: "L1",
};

/** What the page was told never to load, over the whole run (once per page). */
const blockedUrls: string[] = [];

/** Marking, fetching and typing, in the order they happened. */
const timeline: string[] = [];

/** The inputs every test starts with: a login, a card field, a search box, and a provider's card field. */
const startingFields = () => ({
  tab: {
    "#password": { id: 501, attributes: ["type", "password"] },
    "#card": {
      id: 502,
      attributes: ["type", "text", "autocomplete", "cc-number"],
    },
    "#q": { id: 503, attributes: ["type", "search", "name", "q"] },
  },
  F1: {
    "input[name=cardnumber]": {
      id: 601,
      attributes: ["type", "tel", "autocomplete", "cc-number one-time-code"],
    },
  },
});

/** A document's DOM as `DOM.getDocument` returns it, from its declared inputs. */
const domOf = (target: string) => ({
  root: {
    nodeName: "#document",
    children: Object.values(page.fields[target] ?? {}).map((input) => ({
      nodeName: "INPUT",
      backendNodeId: input.id,
      attributes: input.attributes,
    })),
  },
});

/** One field's facts as the page has them now. */
const liveFactsOf = (target: string, selector: string) => {
  const declared = page.fields[target]?.[selector];
  const attributes =
    page.liveAttributes[selector] ?? declared?.attributes ?? [];
  const facts = factsFromDocument({
    nodeName: "#document",
    children: [{ nodeName: "INPUT", backendNodeId: 1, attributes }],
  }).get(1);
  return facts;
};

/** A document's answers to the commands the server and `SecretFields` send. */
const respond = (
  target: string,
  method: string,
  params: Record<string, unknown> = {}
): unknown => {
  commands.push({ target, method, params });
  const expression = String(params.expression ?? "");
  const fn = String(params.functionDeclaration ?? "");
  switch (method) {
    case "Runtime.evaluate": {
      if (params.returnByValue === false) {
        if (expression === FIND_SECRET_FIELDS_SCRIPT)
          return { result: { objectId: `${target}-found` } };
        if (expression.includes("document.activeElement"))
          return { result: { objectId: `${target}-elsewhere` } };
        const selector = /querySelector\((".*?")\)/.exec(expression)?.[1];
        return {
          result: {
            objectId: `${target}-field:${selector != null ? JSON.parse(selector) : ""}`,
          },
        };
      }
      if (expression.includes(frameSnapshotScript(1)))
        return { result: { value: FRAME_SNAPSHOT } };
      if (expression.includes(SNAPSHOT_BUILD_JS))
        return { result: { value: { ...SNAPSHOT, url: page.url } } };
      if (expression.includes(DOCUMENT_INPUT_FACTS_SCRIPT))
        return {
          result: {
            value: [...factsFromDocument(domOf(target).root).values()],
          },
        };
      if (expression.includes("slowScript"))
        return holdScript.then(() => ({ result: { value: 1 } }));
      if (expression.includes("innerText"))
        return { result: { value: page.totalText } };
      if (expression.includes("closest('a[href]"))
        return { result: { value: page.linkHref } };
      return { result: { value: true } };
    }
    case "Runtime.callFunctionOn": {
      const objectId = String(params.objectId);
      if (fn.includes("editable:"))
        return {
          result: {
            value: {
              connected: true,
              editable: true,
              facts: liveFactsOf(target, objectId.split("-field:")[1] ?? ""),
            },
          },
        };
      if (fn.includes("data-abacusai-secret") && objectId.includes("-field:"))
        timeline.push("marked");
      if (fn.includes("ancestorOrigins")) {
        const own =
          page.armOrigin[target] ??
          (target === "tab" ? page.top : page.frame) ??
          "null";
        return {
          result: {
            value: {
              focused: page.focusedAtArm,
              origin: own,
              top: target === "tab" ? own : page.top,
            },
          },
        };
      }
      if (fn.includes("document.activeElement === this; }"))
        return { result: { value: page.focusedAfterTyping } };
      if (fn.includes("length > 0")) return { result: { value: true } };
      return { result: { value: true } };
    }
    case "Runtime.getProperties":
      return { result: [] };
    case "DOM.describeNode": {
      const objectId = String(params.objectId);
      const selector = objectId.split("-field:")[1];
      return {
        node: {
          backendNodeId: objectId.endsWith("elsewhere")
            ? 777
            : (page.fields[target]?.[selector ?? ""]?.id ?? 999),
        },
      };
    }
    case "DOM.getDocument":
      return domOf(target);
    case "DOM.resolveNode":
      return { object: { objectId: `node-${String(params.backendNodeId)}` } };
    case "Page.getFrameTree":
      return {
        frameTree: {
          frame: { id: "main", loaderId: page.loader },
          childFrames: page.treeFrames.map((origin, index) => ({
            frame: { id: `child-${index}`, securityOrigin: origin },
          })),
        },
      };
    case "Input.insertText":
      timeline.push("typed");
      return {};
    case "Network.setBlockedURLs":
      if (page.refuseBlock) throw new Error("not allowed");
      blockedUrls.push(...((params.urls as string[]) ?? []));
      return {};
    default:
      return {};
  }
};

const makeTab = (): BrowserPage => ({
  id: 7,
  isDestroyed: () => false,
  getURL: () => page.url,
  getTitle: () => SNAPSHOT.title,
  isLoading: () => false,
  loadURL: async (url) => {
    page.loads.push(url);
    page.url = url;
  },
  canGoBack: () => false,
  canGoForward: () => false,
  goBack: () => {},
  goForward: () => {},
  reload: () => {},
  focus: () => {},
  on: () => undefined,
  off: () => undefined,
  capturePage: async () => ({ toPNG: () => Buffer.from("png") }),
  debugger: {
    isAttached: () => true,
    attach: () => {},
    sendCommand: async (method, params) => respond("tab", method, params),
  },
});
let tab = makeTab();

let frames: Array<{ frameId: string; origin: string | null }> = [];
let secrets = new SecretFields();
const originAsked = vi.fn();

const source = {
  presentsInApp: false,
  candidates: () => [
    {
      id: tab.id,
      url: tab.getURL(),
      sessionId: "s1",
      presented: true,
      current: true,
    },
  ],
  webContents: (id: number) => (id === tab.id ? tab : null),
  materialize: async () => tab.id,
  secrets: () => secrets,
  liveOrigin: async (_id: number, frameId?: string) => {
    originAsked(frameId);
    return frameId == null ? page.top : page.frame;
  },
  frames: () => frames,
  framePage: (_id: number, frameId: string) =>
    frames.some((frame) => frame.frameId === frameId)
      ? framePageOf(tab, frameId, async (method, params) =>
          respond(frameId, method, params)
        )
      : null,
};

/** What the platform was asked, by method; it spends each card field of an approval once. */
const platformCalls: Array<{ method: string; body: Record<string, unknown> }> =
  [];
const spent = new Set<string>();
/** Set to keep a script (one whose code says `slowScript`) running. */
let holdScript: Promise<void> = Promise.resolve();
/** Set to keep the vault's answer to a fill waiting. */
let holdFill: Promise<void> = Promise.resolve();
const platformFetch = (async (input: URL | string, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = url.pathname.split("/").at(-1)!;
  const body =
    init?.body != null
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : Object.fromEntries(url.searchParams);
  platformCalls.push({ method, body });
  if (method === "_fillAbacusbotVaultField") {
    timeline.push("fetched");
    await holdFill;
  }
  if (method === "_fillAbacusbotVaultField" && body.paymentApprovalId != null) {
    const key = `${String(body.paymentApprovalId)}:${String(body.field)}`;
    if (spent.has(key))
      return new Response(
        JSON.stringify({
          success: false,
          error:
            "This payment approval was already used. Ask for a new approval.",
        }),
        { status: 403 }
      );
    spent.add(key);
  }
  const result =
    method === "_fillAbacusbotVaultField"
      ? { value: body.field === "card_number" ? CARD : SECRET }
      : method === "_createAbacusbotPaymentApproval"
        ? {
            paymentApprovalId: "pay-1",
            url: "https://example.test/app/vault/payment?r=abc",
            amount: body.amount,
            currency: body.currency,
            site: "shop.example",
            expiresAt: Math.floor(Date.now() / 1000) + 1800,
          }
        : null;
  return new Response(JSON.stringify({ success: true, result }));
}) as unknown as typeof fetch;

let server: import("./mcp-browser-server").McpBrowserServer;
let vault: import("../vault/vault-tools").Vault;
let port: number;
let token: string;
/** Every raw MCP response body, for the value check. */
const responses: string[] = [];

const rpc = async (body: unknown): Promise<string> => {
  const res = await fetch(`http://127.0.0.1:${port}/mcp?session=s1`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  responses.push(raw);
  return raw;
};

const call = async (
  name: string,
  args: Record<string, unknown>
): Promise<{ text: string; isError: boolean }> => {
  const raw = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const result = (
    JSON.parse(raw) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
    }
  ).result;
  return {
    text: result?.content?.[0]?.text ?? "",
    isError: result?.isError === true,
  };
};

const approve = (amount = "1234.00", cvvRequired = false): void => {
  vault.sessions.for("s1").approval = {
    id: `pay-${Math.random()}`,
    item: "card-1",
    merchant: "Shop",
    amount,
    currency: "INR",
    site: "shop.example",
    cvvRequired,
    status: "approved",
    used: new Set(),
    codeOrigin: null,
    expiresAt: Date.now() + 60_000,
  };
};

const fills = () =>
  platformCalls.filter((entry) => entry.method === "_fillAbacusbotVaultField");
const typed = () =>
  commands.filter((entry) => entry.method === "Input.insertText");
const fillCard = (extra: Record<string, unknown> = {}) =>
  call("browser_vault_fill", {
    item_id: "card-1",
    field: "card_number",
    ref: "@e2",
    total_ref: "@e3",
    ...extra,
  });

let logged: unknown[][] = [];

beforeAll(async () => {
  process.env.ABACUSAI_BOT_HOME = path.join(
    os.tmpdir(),
    "abacusai-bot-vault-test"
  );
  const { McpBrowserServer } = await import("./mcp-browser-server");
  const { localMcpServerToken } = await import("./mcp-config-service");
  const { VaultClient } = await import("../vault/vault-client");
  const { Vault } = await import("../vault/vault-tools");
  vault = new Vault({
    client: new VaultClient({
      fetch: platformFetch,
      apiKey: () => "bot-key",
      host: () => "https://example.test",
      userAgent: () => "test",
    }),
    deliver: () => {},
  });
  token = localMcpServerToken("browser");
  server = new McpBrowserServer({
    target: () => source,
    vault,
    timeouts: { attachMs: 300, navigateMs: 600, historyMs: 600 },
  });
  port = await server.start();
});

afterAll(() => {
  server.stop();
  vault.stop();
});

beforeEach(() => {
  commands.length = 0;
  platformCalls.length = 0;
  hostEvents.length = 0;
  Object.assign(page, {
    url: CHECKOUT,
    top: "https://www.shop.example",
    frame: "https://js.stripe.com",
    armOrigin: {},
    focusedAtArm: true,
    focusedAfterTyping: true,
    totalText: "Total ₹1,234.00",
    linkHref: null,
    loads: [],
    fields: startingFields(),
    liveAttributes: {},
    refuseBlock: false,
    treeFrames: [],
    loader: "L1",
  });
  timeline.length = 0;
  // A fresh page each time: one the browser has not been told anything about yet.
  tab = makeTab();
  holdFill = Promise.resolve();
  holdScript = Promise.resolve();
  frames = [];
  secrets = new SecretFields();
  vault.sessions.for("s1").approval = null;
  originAsked.mockClear();
  logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const snapshot = async (): Promise<string> =>
  (await call("browser_snapshot", { action: "snapshot" })).text;

describe("the vault's tools on the browser server", () => {
  it("lists the parent's tools and browser_vault_fill when the vault is there", async () => {
    const raw = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (
      JSON.parse(raw) as { result: { tools: Array<{ name: string }> } }
    ).result.tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "vault_items",
        "vault_request",
        "payment_approval",
        "browser_vault_fill",
      ])
    );
  });
});

describe("browser_vault_fill", () => {
  it("types the value into the live field and tells the model only that it did", async () => {
    await snapshot();

    const result = await call("browser_vault_fill", {
      item_id: "login-1",
      field: "password",
      ref: "@e1",
    });

    expect(result).toEqual({
      text: "Filled password into @e1 (hidden).",
      isError: false,
    });
    expect(typed()).toEqual([
      { target: "tab", method: "Input.insertText", params: { text: SECRET } },
    ]);
  });

  it("asks the vault for the live tab's origin, never one the model passed", async () => {
    await snapshot();
    page.top = "https://accounts.shop.example";

    await call("browser_vault_fill", {
      item_id: "login-1",
      field: "password",
      ref: "@e1",
      origin: "https://attacker.example",
    });

    expect(originAsked).toHaveBeenCalled();
    expect(fills()[0]!.body).toEqual({
      itemId: "login-1",
      field: "password",
      origin: "https://accounts.shop.example",
    });
  });

  it("fails closed when the live origin cannot be read", async () => {
    await snapshot();
    page.top = null;

    const result = await call("browser_vault_fill", {
      item_id: "login-1",
      field: "password",
      ref: "@e1",
    });

    expect(result.isError).toBe(true);
    expect(fills()).toHaveLength(0);
    expect(typed()).toHaveLength(0);
  });

  it("registers the filled field with the tab's secret fields, so execute stays locked and the mark is kept", async () => {
    await snapshot();
    await call("browser_vault_fill", {
      item_id: "login-1",
      field: "password",
      ref: "@e1",
    });

    commands.length = 0;
    expect((await call("browser_execute", { code: "1" })).isError).toBe(true);
    await snapshot();
    expect(
      commands.some(
        (entry) =>
          entry.method === "DOM.resolveNode" &&
          entry.params.backendNodeId === 501
      )
    ).toBe(true);
  });

  it("never lets the value into a result, a log, an event or a page script", async () => {
    frames = [{ frameId: "F1", origin: "https://js.stripe.com" }];
    approve();
    await snapshot();
    await call("browser_vault_fill", {
      item_id: "login-1",
      field: "password",
      ref: "@e1",
    });
    await call("browser_vault_fill", {
      item_id: "card-1",
      field: "card_number",
      ref: "@f1e1",
      total_ref: "@e3",
    });
    await snapshot();

    expect(typed().map((entry) => entry.params.text)).toEqual([SECRET, CARD]);
    const everywhere = JSON.stringify({
      responses,
      logged,
      hostEvents,
      scripts: commands
        .filter((entry) => entry.method !== "Input.insertText")
        .map((entry) => entry.params),
    });
    expect(everywhere).not.toContain(SECRET);
    expect(everywhere).not.toContain(CARD);
  });

  it("types a card into a payment provider's frame, in that frame's own session, with the page's total", async () => {
    frames = [{ frameId: "F1", origin: "https://js.stripe.com" }];
    approve();
    const tree = await snapshot();
    expect(tree).toContain("@f1e1");

    const result = await call("browser_vault_fill", {
      item_id: "card-1",
      field: "card_number",
      ref: "@f1e1",
      total_ref: "@e3",
    });

    expect(result.isError).toBe(false);
    expect(typed()).toEqual([
      { target: "F1", method: "Input.insertText", params: { text: CARD } },
    ]);
    expect(fills()[0]!.body).toMatchObject({
      itemId: "card-1",
      field: "card_number",
      origin: "https://www.shop.example",
      frameOrigin: "https://js.stripe.com",
      amount: "1234.00",
      currency: "INR",
    });
  });

  it("refuses a card for a cross-origin frame that is not a payment provider's, asking the vault nothing", async () => {
    frames = [{ frameId: "F1", origin: "https://ads.example" }];
    page.frame = "https://ads.example";
    approve();
    await snapshot();

    const result = await call("browser_vault_fill", {
      item_id: "card-1",
      field: "card_number",
      ref: "@f1e1",
      total_ref: "@e3",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("ads.example");
    expect(fills()).toHaveLength(0);
    expect(typed()).toHaveLength(0);
  });

  it("refuses a card with no total named, whatever amount the model says", async () => {
    approve();
    await snapshot();

    const result = await fillCard({
      total_ref: undefined,
      amount_on_page: "1234.00",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("total_ref");
    expect(fills()).toHaveLength(0);
  });

  it("refuses a card when the page's own total is not the approved one, whatever the model says", async () => {
    approve("1234.00");
    page.totalText = "Total ₹1,299.00";
    await snapshot();

    const result = await fillCard({ amount_on_page: "1234.00" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("1234.00 INR");
    expect(fills()).toHaveLength(0);
    expect(typed()).toHaveLength(0);
  });

  it("refuses a card when the total cannot be read as one amount", async () => {
    approve();
    page.totalText = "2 tickets, ₹1,234.00";
    await snapshot();

    expect((await fillCard()).isError).toBe(true);
    expect(fills()).toHaveLength(0);
  });

  it("refuses a second fill of a field under one approval, before the server is asked", async () => {
    approve();
    await snapshot();

    expect((await fillCard()).isError).toBe(false);
    const second = await fillCard();

    expect(second.isError).toBe(true);
    expect(second.text).toContain("already filled once");
    expect(fills()).toHaveLength(1);
    expect(typed()).toHaveLength(1);
  });

  it("is refused by the server's single use too, when the host has lost track", async () => {
    approve();
    await snapshot();
    await fillCard();
    vault.sessions.for("s1").approval!.used.clear();

    const second = await fillCard();

    expect(second.isError).toBe(true);
    expect(second.text).toContain("already used");
    expect(typed()).toHaveLength(1);
  });

  it("refuses a card with no approved payment", async () => {
    await snapshot();

    expect((await fillCard()).isError).toBe(true);
    expect(fills()).toHaveLength(0);
  });

  it("types nothing when the field's frame navigated between the check and the typing", async () => {
    frames = [{ frameId: "F1", origin: "https://js.stripe.com" }];
    approve();
    await snapshot();
    page.armOrigin.F1 = "https://evil.example";

    const result = await call("browser_vault_fill", {
      item_id: "card-1",
      field: "card_number",
      ref: "@f1e1",
      total_ref: "@e3",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Nothing was typed");
    expect(typed()).toHaveLength(0);
  });

  it("types nothing when the page navigated between the check and the typing", async () => {
    await snapshot();
    // The host read the page's origin; by the arm check the page is elsewhere.
    page.armOrigin.tab = "https://evil.example";

    const result = await call("browser_vault_fill", {
      item_id: "login-1",
      field: "password",
      ref: "@e1",
    });

    expect(result.isError).toBe(true);
    expect(typed()).toHaveLength(0);
  });

  it("types nothing when the focus moved off the field before typing", async () => {
    await snapshot();
    page.focusedAtArm = false;

    const result = await call("browser_vault_fill", {
      item_id: "login-1",
      field: "password",
      ref: "@e1",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Nothing was typed");
    expect(typed()).toHaveLength(0);
  });

  it("clears and hides whatever took the text when the focus moved while typing", async () => {
    await snapshot();
    page.focusedAfterTyping = false;

    const result = await call("browser_vault_fill", {
      item_id: "login-1",
      field: "password",
      ref: "@e1",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("cleared");
    const cleared = commands.find(
      (entry) =>
        entry.method === "Runtime.callFunctionOn" &&
        entry.params.objectId === "tab-elsewhere" &&
        String(entry.params.functionDeclaration).includes("textContent = ''")
    );
    expect(cleared).toBeDefined();
    commands.length = 0;
    await snapshot();
    expect(
      commands.some(
        (entry) =>
          entry.method === "DOM.resolveNode" &&
          entry.params.backendNodeId === 777
      )
    ).toBe(true);
  });
});

describe("Abacus.AI's own pages and APIs", () => {
  it("are never opened by URL, the vault's pages and the API alike", async () => {
    for (const url of [
      "https://apps.abacus.ai/chatllm/vault?r=abc",
      "abacus.ai/app/vault/payment?r=abc",
      "https://apps.abacus.ai/api/v1/_getAbacusbotVaultRequest?requestId=abc",
    ]) {
      const result = await call("browser_navigate", { action: "goto", url });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Abacus.AI's own pages");
    }
    expect(page.loads).toEqual([]);
  });

  it("are never opened by clicking a link to one", async () => {
    await snapshot();
    page.linkHref = "https://abacus.ai/app/vault/payment?r=abc";

    const result = await call("browser_interact", {
      action: "click",
      ref: "@e4",
    });

    expect(result.isError).toBe(true);
    expect(
      commands.some(
        (entry) =>
          entry.method === "Runtime.evaluate" &&
          String(entry.params.expression).includes("el.click()")
      )
    ).toBe(false);
  });

  it("are not reached by a script that names them", async () => {
    const result = await call("browser_execute", {
      code: "fetch('https://apps.abacus.ai/api/v1/_getAbacusbotVaultRequest?requestId=x')",
    });

    expect(result.isError).toBe(true);
    expect(
      commands.some((entry) =>
        String(entry.params.expression).includes("fetch(")
      )
    ).toBe(false);
  });

  it("are blocked for every load the page makes, once the browser drives it", async () => {
    await snapshot();

    expect(blockedUrls).toEqual(
      expect.arrayContaining(["*://abacus.ai/*", "*://*.abacus.ai/*"])
    );
  });

  it("refuse the next action when a timer took the tab to one, and leave it", async () => {
    await snapshot();
    // A script's timer navigated the tab to a payment approval since the last call.
    page.url = "https://abacus.ai/app/vault/payment?r=abc";

    const result = await call("browser_interact", {
      action: "click",
      ref: "@e3",
    });

    expect(result.isError).toBe(true);
    expect(page.loads).toEqual(["about:blank"]);
    expect(
      commands.some((entry) =>
        String(entry.params.expression).includes("el.click()")
      )
    ).toBe(false);
  });

  it("refuse an action on a tab whose live origin is one, whatever its URL said", async () => {
    await snapshot();
    page.top = "https://apps.abacus.ai";

    const result = await call("browser_interact", {
      action: "click",
      ref: "@e3",
    });

    expect(result.isError).toBe(true);
    expect(page.loads).toEqual(["about:blank"]);
  });

  it("stop a page script in the same evaluation when its document is on one", async () => {
    await snapshot();
    // The check before the call saw the shop; the script itself runs on the approval page.
    const realRespond = tab.debugger.sendCommand;
    tab.debugger.sendCommand = async (method, params) => {
      const expression = String(params?.expression ?? "");
      if (
        method === "Runtime.evaluate" &&
        expression.includes("abacusai-host-fence")
      )
        return {
          exceptionDetails: {
            exception: { description: "Error: abacusai-host-fence" },
          },
        };
      return realRespond(method, params);
    };

    const result = await call("browser_execute", { code: "fetch('/api/x')" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Abacus.AI's own pages");
  });

  it("put the fence check inside every page script the browser runs", async () => {
    await snapshot();

    const scripts = commands.filter(
      (entry) =>
        entry.method === "Runtime.evaluate" &&
        String(entry.params.expression).includes(SNAPSHOT_BUILD_JS)
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts)
      expect(String(script.params.expression)).toContain("abacusai-host-fence");
  });

  it("refuse every call on a page the browser would not tell to block them", async () => {
    page.refuseBlock = true;

    const result = await call("browser_snapshot", { action: "snapshot" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("could not be set up safely");
    expect(
      commands.some((entry) =>
        String(entry.params.expression).includes(SNAPSHOT_BUILD_JS)
      )
    ).toBe(false);

    // Remembered only once it worked: the next try asks again.
    page.refuseBlock = false;
    expect(
      (await call("browser_snapshot", { action: "snapshot" })).isError
    ).toBe(false);
  });

  it("are left at once when the browser lands on one some other way", async () => {
    page.url = "https://abacus.ai/app/vault/login?r=abc";

    const result = await call("browser_snapshot", { action: "snapshot" });

    expect(result.isError).toBe(true);
    expect(page.loads).toEqual(["about:blank"]);
  });
});

describe("what a vault fill guards", () => {
  it("refuses a field that is not the kind the value goes into, before any value is asked for", async () => {
    await snapshot();

    const result = await call("browser_vault_fill", {
      item_id: "login-1",
      field: "password",
      ref: "@e5",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("password field");
    expect(fills()).toHaveLength(0);
    expect(typed()).toHaveLength(0);
  });

  it("judges a field by what it was when first seen: a search box made a password field is still refused", async () => {
    await snapshot();
    // Changed after the snapshot (by the page, or anything else that could).
    page.liveAttributes["#q"] = ["type", "password", "name", "q"];

    const result = await call("browser_vault_fill", {
      item_id: "login-1",
      field: "password",
      ref: "@e5",
    });

    expect(result.isError).toBe(true);
    expect(fills()).toHaveLength(0);
  });

  it("refuses a field that was never seen in a snapshot", async () => {
    await snapshot();
    page.fields.tab!["#password"]!.id = 9001;

    const result = await call("browser_vault_fill", {
      item_id: "login-1",
      field: "password",
      ref: "@e1",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("not known what kind of field");
    expect(fills()).toHaveLength(0);
  });

  it("fills nothing into a page a script ran on, before the field even appeared, until it loads anew", async () => {
    // A listener set up now would copy whatever is typed later.
    await call("browser_execute", {
      code: "document.addEventListener('input', (e) => { document.title = e.target.value })",
    });
    await snapshot();

    const refused = await call("browser_vault_fill", {
      item_id: "login-1",
      field: "password",
      ref: "@e1",
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("script ran");
    expect(fills()).toHaveLength(0);

    page.loader = "L2";
    await snapshot();
    expect(
      (
        await call("browser_vault_fill", {
          item_id: "login-1",
          field: "password",
          ref: "@e1",
        })
      ).isError
    ).toBe(false);
  });

  it("marks and locks the field before the value is asked for, and types after", async () => {
    await snapshot();

    await call("browser_vault_fill", {
      item_id: "login-1",
      field: "password",
      ref: "@e1",
    });

    expect(timeline).toEqual(["marked", "fetched", "typed"]);
  });

  it("makes every other call on the tab wait for a fill in flight", async () => {
    await snapshot();
    let release!: () => void;
    holdFill = new Promise((resolve) => {
      release = resolve;
    });

    const filling = call("browser_vault_fill", {
      item_id: "login-1",
      field: "password",
      ref: "@e1",
    });
    await vi.waitFor(() => expect(timeline).toContain("fetched"));
    const reading = call("browser_snapshot", { action: "snapshot" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const snapshotsSoFar = commands.filter((entry) =>
      String(entry.params.expression).includes(SNAPSHOT_BUILD_JS)
    ).length;
    release();
    await Promise.all([filling, reading]);

    const typedAt = commands.findIndex(
      (entry) => entry.method === "Input.insertText"
    );
    const lastSnapshotAt = commands.findLastIndex((entry) =>
      String(entry.params.expression).includes(SNAPSHOT_BUILD_JS)
    );
    expect(snapshotsSoFar).toBe(1);
    expect(lastSnapshotAt).toBeGreaterThan(typedAt);
  });

  it("makes a fill issued while a script runs wait for it, then refuses it", async () => {
    await snapshot();
    let release!: () => void;
    holdScript = new Promise((resolve) => {
      release = resolve;
    });

    const scripting = call("browser_execute", { code: "slowScript()" });
    await vi.waitFor(() =>
      expect(
        commands.some((entry) =>
          String(entry.params.expression).includes("slowScript")
        )
      ).toBe(true)
    );
    const filling = call("browser_vault_fill", {
      item_id: "login-1",
      field: "password",
      ref: "@e1",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fills()).toHaveLength(0);
    release();
    const [, filled] = await Promise.all([scripting, filling]);

    expect(filled.isError).toBe(true);
    expect(filled.text).toContain("script");
    expect(fills()).toHaveLength(0);
    expect(typed()).toHaveLength(0);
  });

  it("holds a script issued while a fill is typing until the fill is done, when the filled field locks it out", async () => {
    await snapshot();
    let release!: () => void;
    holdFill = new Promise((resolve) => {
      release = resolve;
    });

    const filling = call("browser_vault_fill", {
      item_id: "login-1",
      field: "password",
      ref: "@e1",
    });
    await vi.waitFor(() => expect(timeline).toContain("fetched"));
    const scripting = call("browser_execute", { code: "slowScript()" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const [filled, scripted] = await Promise.all([filling, scripting]);

    const typedAt = commands.findIndex(
      (entry) => entry.method === "Input.insertText"
    );
    const scriptAt = commands.findIndex((entry) =>
      String(entry.params.expression).includes("slowScript")
    );
    expect(filled.isError).toBe(false);
    expect(typedAt).toBeGreaterThanOrEqual(0);
    // It never ran while the value was typed; after, the filled field refuses it.
    expect(scriptAt).toBe(-1);
    expect(scripted.isError).toBe(true);
    expect(scripted.text).toContain("cannot run");
  });

  it("fills nothing, and runs no script, on a page the browser cannot name", async () => {
    await snapshot();
    page.loader = "";

    const filled = await call("browser_vault_fill", {
      item_id: "login-1",
      field: "password",
      ref: "@e1",
    });
    const scripted = await call("browser_execute", { code: "1 + 1" });

    expect(filled.isError).toBe(true);
    expect(filled.text).toContain("could not say which page");
    expect(scripted.isError).toBe(true);
    expect(fills()).toHaveLength(0);
  });

  it("refuses copy, cut and paste keys on a page with a filled field", async () => {
    await snapshot();
    await call("browser_vault_fill", {
      item_id: "login-1",
      field: "password",
      ref: "@e1",
    });
    commands.length = 0;

    for (const key of ["Control+c", "Meta+v", "Control+x", "Shift+Insert"]) {
      const result = await call("browser_interact", { action: "press", key });
      expect(result.isError).toBe(true);
    }
    expect(
      commands.some((entry) => entry.method === "Input.dispatchKeyEvent")
    ).toBe(false);
  });

  it("runs no script on a checkout with a payment provider's frame", async () => {
    page.treeFrames = ["https://js.stripe.com"];

    const result = await call("browser_execute", { code: "1 + 1" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("payment provider");
  });

  it("reads no total from a page a script ran on, until a new document loads", async () => {
    approve();
    await call("browser_execute", { code: "1 + 1" });
    await snapshot();

    const refused = await fillCard();
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("script ran");
    expect(fills()).toHaveLength(0);

    page.loader = "L2";
    await snapshot();
    expect((await fillCard()).isError).toBe(false);
  });

  it("types a bank's code into the bank's frame the code was asked for on", async () => {
    frames = [{ frameId: "F1", origin: "https://acs.bank.example" }];
    page.frame = "https://acs.bank.example";
    approve();
    vault.sessions.for("s1").approval!.codeOrigin = "https://acs.bank.example";
    await snapshot();

    const result = await call("browser_vault_fill", {
      item_id: "card-1",
      field: "code",
      ref: "@f1e1",
    });

    expect(result.isError).toBe(false);
    expect(fills()[0]!.body).toMatchObject({
      field: "code",
      origin: "https://acs.bank.example",
      frameOrigin: "https://acs.bank.example",
    });
  });

  it("lets a second fill of the field through again when the vault refused the first", async () => {
    approve();
    await snapshot();
    spent.add(`${vault.sessions.for("s1").approval!.id}:card_number`);

    expect((await fillCard()).isError).toBe(true);
    expect(vault.sessions.for("s1").approval!.used.has("card_number")).toBe(
      false
    );
  });
});

describe("payment_approval", () => {
  it("binds the approval to the live tab's origin", async () => {
    page.top = "https://pay.shop.example";

    const result = await call("payment_approval", {
      item_id: "card-1",
      merchant: "Shop",
      amount: "1234.00",
      currency: "inr",
      origin: "https://attacker.example",
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("https://example.test/app/vault/payment");
    expect(
      platformCalls.find(
        (entry) => entry.method === "_createAbacusbotPaymentApproval"
      )?.body
    ).toEqual({
      itemId: "card-1",
      merchant: "Shop",
      amount: "1234.00",
      currency: "INR",
      origin: "https://pay.shop.example",
      cvvRequired: false,
    });
    expect(vault.sessions.get("s1")?.approval?.status).toBe("pending");
  });
});
