/**
 * Hosted free accounts can't run local MCP servers or the terminal. The plan
 * is the server's account reply (fetch stands in for the server); everything
 * from there to the runtime file the agent reads is the real code.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  sessionConversationKey,
  sessionConversationRef,
} from "@abacus-ai/contract/conversation-scope";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());
vi.stubGlobal("fetch", fetchMock);

// The MCP config service resolves its home at import time.
const home = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodeOs = require("node:os") as typeof import("node:os");
  const dir = nodeFs.mkdtempSync(`${nodeOs.tmpdir()}/hosted-local-tools-`);
  process.env.ABACUSAI_BOT_HOME = dir;
  return dir;
});

vi.mock("electron", () => {
  const anything: unknown = new Proxy(function () {}, {
    get: (_target, key) => (key === "then" ? undefined : anything),
    apply: () => anything,
    construct: () => anything as object,
  });
  return new Proxy(
    {
      default: anything,
      app: {
        isPackaged: false,
        getPath: () => process.env.ABACUSAI_BOT_HOME,
        getVersion: () => "1.0.86",
        getLocale: () => "en-US",
        getPreferredSystemLanguages: () => ["en-US"],
      },
    },
    {
      get: (target, key) =>
        key in target
          ? (target as Record<PropertyKey, unknown>)[key]
          : key === "then"
            ? undefined
            : anything,
      has: () => true,
    }
  );
});

vi.mock("../services/config/settings", async (importActual) => ({
  ...(await importActual<typeof import("../services/config/settings")>()),
  hasCredential: () => true,
  credentialFor: (name: string) =>
    name === "ABACUS_API_KEY" ? "test-key" : "",
}));

const { clearAbacusCache } = await import("../services/providers/abacus");
const { ServiceHost } = await import("../service-host");
const { hostedLocalToolsRefusal } = await import("./hosted-local-tools");
const { connectInProcess, fakeDeps } = await import("../rpc/testing");

const accountReply = (tier: string): Response =>
  new Response(JSON.stringify({ subscription_tier: tier, plan: tier }), {
    status: 200,
  });

/** The server answers /account with `tier`, and nothing else is asked of it. */
const planIs = (tier: string) =>
  fetchMock.mockImplementation(async (url: string) =>
    String(url).endsWith("/account")
      ? accountReply(tier)
      : new Response("{}", { status: 404 })
  );

const LOCAL = { command: "node", args: ["server.js"] };
const REMOTE = { url: "https://mcp.example.test/mcp" };

let userHome: string;
beforeEach(() => {
  fetchMock.mockReset();
  clearAbacusCache();
  for (const name of fs.readdirSync(home))
    fs.rmSync(path.join(home, name), { recursive: true, force: true });
  userHome = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-user-home-"));
  vi.spyOn(os, "homedir").mockReturnValue(userHome);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(userHome, { recursive: true, force: true });
});
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const runtimeServers = async (
  host: InstanceType<typeof ServiceHost>
): Promise<string[]> => {
  const file = await host.getRuntimeMcpPathForSpawn("code", "s1");
  const written = JSON.parse(fs.readFileSync(file, "utf8")) as {
    mcpServers: Record<string, { isBuiltin?: boolean }>;
  };
  return Object.entries(written.mcpServers)
    .filter(([, entry]) => entry.isBuiltin !== true)
    .map(([name]) => name)
    .sort();
};

/** Local servers through each add path: add, update, import from a config file, and a hand edit. */
const addThroughEveryPath = async (
  host: InstanceType<typeof ServiceHost>
): Promise<void> => {
  fs.writeFileSync(
    path.join(home, "mcp-code.json"),
    JSON.stringify({
      mcpServers: {
        "hand-edited": LOCAL,
        remote: REMOTE,
        "was-remote": REMOTE,
      },
    })
  );
  expect(
    host.addMcpServer({ mode: "code", name: "added", config: LOCAL })
  ).toEqual({ success: true });
  expect(
    host.updateMcpServer({
      mode: "code",
      name: "was-remote",
      config: { ...LOCAL, url: undefined },
    })
  ).toEqual({ success: true });
  fs.mkdirSync(path.join(userHome, ".cursor"));
  fs.writeFileSync(
    path.join(userHome, ".cursor", "mcp.json"),
    JSON.stringify({ mcpServers: { imported: LOCAL } })
  );
  expect(
    await host.importMcpServers({ mode: "code", source: "cursor" })
  ).toMatchObject({ success: true, imported: 1 });
};

const EVERY_SERVER = [
  "added",
  "hand-edited",
  "imported",
  "remote",
  "was-remote",
];

describe("the plan read", () => {
  it("never asks the server on the desktop app", async () => {
    expect(await hostedLocalToolsRefusal("electron")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["free", "plan-required"],
    ["basic", null],
    ["pro", null],
  ])("a hosted %s account reads %s", async (tier, refusal) => {
    planIs(tier);
    expect(await hostedLocalToolsRefusal("web-host")).toBe(refusal);
  });

  it.each([
    ["the server fails", () => new Response("", { status: 500 })],
    ["the server is unreachable", () => Promise.reject(new Error("offline"))],
    ["the account owes a payment", () => new Response("{}", { status: 402 })],
    ["the reply names no plan", () => new Response("{}", { status: 200 })],
  ])("fails closed when %s", async (_case, reply) => {
    fetchMock.mockImplementation(reply);
    expect(await hostedLocalToolsRefusal("web-host")).toBe("plan-unreadable");
  });
});

describe("local MCP servers on a hosted free account", () => {
  it("are left out of the runtime file through every add path, and say why", async () => {
    planIs("free");
    const host = new ServiceHost("web-host");

    await addThroughEveryPath(host);

    expect(await runtimeServers(host)).toEqual(["remote"]);
    const listed = await host.listMcpServers({ mode: "code" });
    expect(
      Object.fromEntries(listed.map((server) => [server.name, server.inactive]))
    ).toEqual({
      added: "plan-required",
      "hand-edited": "plan-required",
      imported: "plan-required",
      remote: undefined,
      "was-remote": "plan-required",
    });
  });

  it("are left out when the plan can't be read", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    const host = new ServiceHost("web-host");

    await addThroughEveryPath(host);

    expect(await runtimeServers(host)).toEqual(["remote"]);
  });

  it("all run for a paid hosted account", async () => {
    planIs("pro");
    const host = new ServiceHost("web-host");

    await addThroughEveryPath(host);

    expect(await runtimeServers(host)).toEqual(EVERY_SERVER);
    const listed = await host.listMcpServers({ mode: "code" });
    expect(listed.every((server) => server.inactive == null)).toBe(true);
  });

  it("all run on the desktop app, whatever the plan", async () => {
    planIs("free");
    const host = new ServiceHost("electron");

    await addThroughEveryPath(host);

    expect(await runtimeServers(host)).toEqual(EVERY_SERVER);
  });
});

describe("terminal.start", () => {
  const started = {
    success: true,
    created: true,
    initialOutput: "",
    state: {} as never,
  };
  const request = {
    terminalId: "terminal-1",
    conversationKey: sessionConversationKey("w1", "s1"),
    conversation: sessionConversationRef("w1", "s1"),
    generation: null,
    cols: 80,
    rows: 24,
  };

  const startThroughRpc = (host: InstanceType<typeof ServiceHost>) => {
    const internals = host as unknown as Record<string, any>;
    const startSession = vi
      .spyOn(internals.terminalSessionService, "startSession")
      .mockResolvedValue(started);
    const connection = connectInProcess(
      fakeDeps({
        serviceHost: {
          startTerminalSession: host.startTerminalSession.bind(host),
        },
      })
    );
    return { connection, startSession };
  };

  it.each([
    ["free", "plan-required"],
    ["unreadable", "plan-unreadable"],
  ])("is refused for a hosted %s account", async (plan, reason) => {
    if (plan === "free") planIs("free");
    else fetchMock.mockResolvedValue(new Response("", { status: 500 }));
    const { connection, startSession } = startThroughRpc(
      new ServiceHost("web-host")
    );
    try {
      await expect(
        connection.client.terminal.start(request)
      ).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        data: { reason },
      });
      expect(startSession).not.toHaveBeenCalled();
    } finally {
      connection.closeClient();
    }
  });

  it.each([
    ["a paid hosted account", "web-host", "pro"],
    ["the desktop app on a free plan", "electron", "free"],
  ] as const)("starts for %s", async (_case, platform, tier) => {
    planIs(tier);
    const { connection, startSession } = startThroughRpc(
      new ServiceHost(platform)
    );
    try {
      await expect(connection.client.terminal.start(request)).resolves.toEqual(
        started
      );
      expect(startSession).toHaveBeenCalledOnce();
    } finally {
      connection.closeClient();
    }
  });
});
