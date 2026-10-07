/**
 * One connect and one disconnect per connector kind, so every Connect button
 * in the app (the page, onboarding, the card the agent raises) does the
 * same thing for the same connector.
 */
import { connectorById } from "@abacus-ai/connectors/registry";
import type { McpServerEntry } from "@abacus-ai/contract/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConnectorFlowService,
  type McpSignIn,
  mcpEntryFor,
} from "./connector-flow-service";

const platformConnect = vi.fn(
  () => ({ ok: true, url: "https://apps.example/connect" }) as const
);
const platformDisconnect = vi.fn(async () => ({ ok: true }) as const);
const watch = vi.fn();
const installed = new Map<string, McpServerEntry>();
const addServer = vi.fn((name: string, entry: McpServerEntry) => {
  installed.set(name, entry);
  return { success: true };
});
const removeServer = vi.fn(() => ({ success: true }));
const signIn = vi.fn(async (_name: string): Promise<McpSignIn> => ({
  kind: "signed-in",
}));
/** The web host's route; null on the desktop. */
let connectUrl: (name: string) => string | null = () => null;

const flow = (): ConnectorFlowService =>
  new ConnectorFlowService({
    platform: {
      connect: platformConnect,
      disconnect: platformDisconnect,
      watch,
    },
    mcp: {
      entry: (name) => installed.get(name),
      add: addServer,
      remove: removeServer,
      signIn,
      connectUrl: (name) => connectUrl(name),
      watch,
    },
    homeDir: () => "/home/ada",
  });

beforeEach(() => {
  vi.clearAllMocks();
  installed.clear();
  connectUrl = () => null;
});

describe("a platform connector", () => {
  it("answers with the connect page by service key and watches for the connection", async () => {
    expect(await flow().connect("abacus-gmailuser")).toEqual({
      ok: true,
      url: "https://apps.example/connect",
    });

    expect(platformConnect).toHaveBeenCalledWith("gmailuser", undefined);
    expect(watch).toHaveBeenCalledWith("abacus-gmailuser");
  });

  it("hands the account hint to the platform", async () => {
    await flow().connect("abacus-gmailuser", { hint: "me@gmail.com" });

    expect(platformConnect).toHaveBeenCalledWith("gmailuser", {
      hint: "me@gmail.com",
    });
  });

  it("watches nothing when no page could be handed out", async () => {
    platformConnect.mockReturnValueOnce({
      ok: false,
      error: "not-signed-in",
    } as never);

    const outcome = await flow().connect("abacus-gmailuser");

    expect(outcome).toMatchObject({ ok: false, error: "not-signed-in" });
    expect(watch).not.toHaveBeenCalled();
  });

  it("detaches by service key", async () => {
    await flow().disconnect("abacus-slack");

    expect(platformDisconnect).toHaveBeenCalledWith("slack");
  });
});

describe("an MCP server connector", () => {
  it("installs a no-auth server on connect, under its registry id", async () => {
    expect(await flow().connect("huggingface")).toEqual({ ok: true });

    expect(addServer).toHaveBeenCalledWith("huggingface", {
      url: "https://huggingface.co/mcp",
    });
    expect(signIn).not.toHaveBeenCalled();
  });

  it("installs an OAuth server and runs its sign-in as part of connecting", async () => {
    expect(await flow().connect("notion")).toEqual({ ok: true });

    expect(addServer).toHaveBeenCalledWith("notion", {
      url: "https://mcp.notion.com/mcp",
    });
    expect(signIn).toHaveBeenCalledWith("notion");
  });

  it("leaves an entry already there as it is, and signs in to it again", async () => {
    installed.set("notion", { url: "https://mcp.notion.com/mcp", env: {} });

    expect(await flow().connect("notion")).toEqual({ ok: true });
    expect(addServer).not.toHaveBeenCalled();
    expect(installed.get("notion")).toEqual({
      url: "https://mcp.notion.com/mcp",
      env: {},
    });
    expect(signIn).toHaveBeenCalledWith("notion");
  });

  it("on the web host, hands out the host's route and installs nothing until it is opened", async () => {
    connectUrl = (name) =>
      `https://apps.example/api/botHost/h1/mcp/connect/${name}`;

    expect(await flow().connect("notion")).toEqual({
      ok: true,
      url: "https://apps.example/api/botHost/h1/mcp/connect/notion",
    });
    expect(addServer).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("connectMcp: the provider's page for a hosted sign-in, watched until it connects", async () => {
    signIn.mockResolvedValueOnce({
      kind: "redirect",
      location: "https://auth.example/authorize?state=s",
    });

    expect(await flow().connectMcp("notion")).toEqual({
      kind: "sign-in",
      label: "Notion",
      location: "https://auth.example/authorize?state=s",
    });
    expect(addServer).toHaveBeenCalledOnce();
    expect(watch).toHaveBeenCalledWith("notion");
  });

  it("connectMcp: the user's own server signs in by its name, and connects at once when it asks for none", async () => {
    installed.set("mine", { url: "https://mine.example/mcp" });
    signIn.mockResolvedValueOnce({ kind: "open" });

    expect(await flow().connectMcp("mine")).toEqual({
      kind: "connected",
      label: "mine",
    });
    expect(signIn).toHaveBeenCalledWith("mine");
    expect(watch).not.toHaveBeenCalled();
    installed.set("local", { command: "npx" });
    expect(await flow().connectMcp("local")).toEqual({
      kind: "connected",
      label: "local",
    });
    expect(await flow().connectMcp("nothing")).toEqual({ kind: "missing" });
    expect(await flow().connectMcp("abacus-slack")).toEqual({
      kind: "missing",
    });
  });

  it("answers a failed sign-in in its own words and logs the server's", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    signIn.mockResolvedValueOnce({
      kind: "failed",
      error: "Could not reach the server: getaddrinfo ENOTFOUND 10.0.0.7",
    });

    expect(await flow().connect("notion")).toEqual({
      ok: false,
      error: "Notion sign-in did not finish.",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ENOTFOUND"));
    warn.mockRestore();
  });

  it("keeps the server but reports a sign-in that did not finish", async () => {
    signIn.mockResolvedValueOnce({ kind: "failed", cancelled: true });

    const outcome = await flow().connect("notion");

    expect(outcome).toMatchObject({ ok: false, cancelled: true });
    expect(removeServer).not.toHaveBeenCalled();
  });

  it("removes the server to disconnect, and reports a removal that failed", async () => {
    expect(await flow().disconnect("notion")).toEqual({ ok: true });
    expect(removeServer).toHaveBeenCalledWith("notion");

    removeServer.mockReturnValueOnce({
      success: false,
      error: "locked",
    } as never);
    expect(await flow().disconnect("notion")).toEqual({
      ok: false,
      error: "locked",
    });
  });
});

describe("the entry a server installs as", () => {
  it("puts a token in its header, keys in the environment, the home in place of the placeholder", () => {
    const entry = mcpEntryFor(
      {
        kind: "mcp",
        id: "x",
        name: "X",
        description: "",
        category: "web",
        docsUrl: "https://x",
        auth: "token",
        entry: { command: "npx", args: ["-y", "x", "{{HOME}}"] },
        token: { header: "Authorization", scheme: "Bearer", label: "Token" },
        env: ["X_KEY"],
      },
      { token: "t0k", X_KEY: "k3y" },
      "/home/ada"
    );

    expect(entry).toEqual({
      command: "npx",
      args: ["-y", "x", "/home/ada"],
      headers: { Authorization: "Bearer t0k" },
      env: { X_KEY: "k3y" },
    });
  });

  it("carries an OAuth client the user registered, and only the parts they gave", () => {
    const entry = mcpEntryFor(
      {
        kind: "mcp",
        id: "y",
        name: "Y",
        description: "",
        category: "web",
        docsUrl: "https://y",
        auth: "oauth-client",
        entry: { url: "https://y/mcp" },
      },
      { clientId: "cid", clientSecret: "" },
      "/home/ada"
    );

    expect(entry.oauth).toEqual({ clientId: "cid" });
  });
});

describe("the kinds the renderer handles itself", () => {
  it("does not connect or disconnect a chat app: the gateway owns that", async () => {
    expect(await flow().connect("messaging-whatsapp")).toMatchObject({
      ok: false,
    });
    expect(await flow().disconnect("messaging-whatsapp")).toMatchObject({
      ok: false,
    });
  });

  it("knows nothing about an id outside the registry", async () => {
    expect(connectorById("myspace")).toBeUndefined();
    expect(await flow().connect("myspace")).toMatchObject({ ok: false });
  });
});
