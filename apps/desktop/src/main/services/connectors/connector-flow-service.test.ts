/**
 * One connect and one disconnect per connector kind, so every Connect button
 * in the app — the page, onboarding, the card the agent raises — does the
 * same thing for the same connector.
 */
import { connectorById } from "@abacus-ai/connectors/registry";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ConnectorFlowService, mcpEntryFor } from "./connector-flow-service";

const platformConnect = vi.fn(async () => ({ ok: true }) as const);
const platformDisconnect = vi.fn(async () => ({ ok: true }) as const);
const ensureGateway = vi.fn();
const saveCredential = vi.fn();
const addServer = vi.fn(() => ({ success: true }));
const removeServer = vi.fn(() => ({ success: true }));
const signIn = vi.fn(async () => ({ success: true }));

const flow = (): ConnectorFlowService =>
  new ConnectorFlowService({
    platform: {
      connect: platformConnect,
      disconnect: platformDisconnect,
      ensureGateway,
    },
    credential: { save: saveCredential },
    mcp: { add: addServer, remove: removeServer, signIn },
    homeDir: () => "/home/ada",
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a platform connector", () => {
  it("runs the browser hop by service key and rewrites the gateway entry after", async () => {
    expect(await flow().connect("abacus-gmailuser")).toEqual({ ok: true });

    expect(platformConnect).toHaveBeenCalledWith("gmailuser");
    expect(ensureGateway).toHaveBeenCalledTimes(1);
  });

  it("leaves the gateway alone when the hop did not finish", async () => {
    platformConnect.mockResolvedValueOnce({
      ok: false,
      error: "cancelled",
      cancelled: true,
    } as never);

    const outcome = await flow().connect("abacus-gmailuser");

    expect(outcome).toMatchObject({ ok: false, cancelled: true });
    expect(ensureGateway).not.toHaveBeenCalled();
  });

  it("detaches by service key", async () => {
    await flow().disconnect("abacus-slack");

    expect(platformDisconnect).toHaveBeenCalledWith("slack");
  });
});

describe("a credential connector", () => {
  it("needs its fields, then stores the token under its provider", async () => {
    expect(await flow().connect("github")).toMatchObject({ ok: false });
    expect(saveCredential).not.toHaveBeenCalled();

    expect(
      await flow().submitFields("github", { GH_TOKEN: " ghp_secret " })
    ).toEqual({ ok: true });

    expect(saveCredential).toHaveBeenCalledWith("github", "ghp_secret");
  });

  it("refuses an empty token", async () => {
    expect(
      await flow().submitFields("github", { GH_TOKEN: "  " })
    ).toMatchObject({ ok: false });
    expect(saveCredential).not.toHaveBeenCalled();
  });

  it("clears the token to disconnect", async () => {
    expect(await flow().disconnect("github")).toEqual({ ok: true });

    expect(saveCredential).toHaveBeenCalledWith("github", "");
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

  it("keeps the server but reports a sign-in that did not finish", async () => {
    signIn.mockResolvedValueOnce({ success: false, cancelled: true } as never);

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
