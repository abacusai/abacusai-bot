/**
 * MCP OAuth tokens at connect time.
 *
 * This is the headless half of the sign-in: no browser, no user, just a stored
 * token and, when it has gone stale, one POST to renew it. Everything that
 * can go wrong is supposed to end the same quiet way, with no Authorization
 * header, a 401 from the server, and a visible "sign in" for the person. A
 * refresh path that threw instead, or one that wrote a half-updated file, would
 * cost the user every stored sign-in on the machine.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authHeadersForServer,
  mcpAuthPath,
  readMcpAuth,
  writeMcpAuth,
  type McpAuthFile,
  type McpTokenRecord,
} from "./auth.js";

const SERVER = "https://mcp.example.com/sse";

let home: string;

const record = (overrides: Partial<McpTokenRecord> = {}): McpTokenRecord => ({
  tokenEndpoint: "https://auth.example.com/token",
  clientId: "client-abc",
  accessToken: "stored-access",
  refreshToken: "stored-refresh",
  ...overrides,
});

const storeAuth = (file: McpAuthFile): void => {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(mcpAuthPath(), JSON.stringify(file));
};

const storedAuth = (): McpAuthFile =>
  JSON.parse(fs.readFileSync(mcpAuthPath(), "utf8")) as McpAuthFile;

/** A token endpoint that answers with `body`, or with a non-2xx status. */
const tokenEndpoint = (
  body: unknown,
  init: { ok?: boolean; status?: number } = {}
): void => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    }))
  );
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-auth-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("reading the token file", () => {
  it("reads an empty file for one that was never written", () => {
    expect(readMcpAuth()).toEqual({});
  });

  it.each([
    ["truncated JSON", '{"servers": {'],
    ["not JSON at all", "not json"],
    ["an empty file", ""],
    ["a JSON array", "[1, 2, 3]"],
  ])("reads an empty file rather than throw on %s", (_label, contents) => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(mcpAuthPath(), contents);

    // An array parses fine but is not the shape callers index by URL.
    expect(readMcpAuth().servers?.[SERVER]).toBeUndefined();
  });

  it("reads a JSON null as an empty file", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(mcpAuthPath(), "null");

    expect(readMcpAuth()).toEqual({});
  });

  it("keeps the file beside everything else under the home directory", () => {
    expect(mcpAuthPath()).toBe(path.join(home, "mcp-auth.json"));
  });
});

describe("writing the token file", () => {
  it("creates the directory when nothing has been written there yet", () => {
    writeMcpAuth({ servers: { [SERVER]: record() } });

    expect(readMcpAuth().servers?.[SERVER]?.accessToken).toBe("stored-access");
  });

  it("leaves no temp file behind", () => {
    // Written through a temp file and renamed, so an interrupted refresh cannot
    // leave a truncated token file: readMcpAuth cannot tell corrupt from absent.
    writeMcpAuth({ servers: { [SERVER]: record() } });

    expect(fs.readdirSync(home)).toEqual(["mcp-auth.json"]);
  });

  // Windows has no POSIX mode bits: chmod there only toggles the read-only flag.
  it.skipIf(process.platform === "win32")(
    "keeps the file readable only by its owner",
    () => {
      writeMcpAuth({ servers: { [SERVER]: record() } });

      // Access tokens are credentials; nothing else on the machine needs them.
      expect(fs.statSync(mcpAuthPath()).mode & 0o777).toBe(0o600);
    }
  );

  it("replaces a file that was already there", () => {
    writeMcpAuth({ servers: { [SERVER]: record({ accessToken: "first" }) } });
    writeMcpAuth({ servers: { [SERVER]: record({ accessToken: "second" }) } });

    expect(readMcpAuth().servers?.[SERVER]?.accessToken).toBe("second");
  });
});

describe("attaching a token to a connection", () => {
  it("sends nothing for a server nobody has signed into", async () => {
    storeAuth({ servers: { "https://other.example.com": record() } });

    await expect(authHeadersForServer(SERVER)).resolves.toEqual({});
  });

  it("sends nothing when there is no token file at all", async () => {
    await expect(authHeadersForServer(SERVER)).resolves.toEqual({});
  });

  it("sends a stored token that has not expired", async () => {
    storeAuth({
      servers: { [SERVER]: record({ expiresAt: Date.now() + 3_600_000 }) },
    });

    await expect(authHeadersForServer(SERVER)).resolves.toEqual({
      Authorization: "Bearer stored-access",
    });
  });

  it("sends a token the server declared no expiry for", async () => {
    storeAuth({ servers: { [SERVER]: record() } });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(authHeadersForServer(SERVER)).resolves.toEqual({
      Authorization: "Bearer stored-access",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renews a token that is about to expire, not only one that has", async () => {
    // A token that dies mid-request is a failure the user sees; the skew is
    // what stops that, so a token inside it must be renewed early.
    storeAuth({
      servers: { [SERVER]: record({ expiresAt: Date.now() + 30_000 }) },
    });
    tokenEndpoint({ access_token: "renewed", expires_in: 3600 });

    await expect(authHeadersForServer(SERVER)).resolves.toEqual({
      Authorization: "Bearer renewed",
    });
  });

  it("keeps sending a token that is comfortably outside the skew", async () => {
    storeAuth({
      servers: { [SERVER]: record({ expiresAt: Date.now() + 120_000 }) },
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(authHeadersForServer(SERVER)).resolves.toEqual({
      Authorization: "Bearer stored-access",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("renewing an expired token", () => {
  const expired = (overrides: Partial<McpTokenRecord> = {}): void => {
    storeAuth({
      servers: {
        [SERVER]: record({ expiresAt: Date.now() - 1_000, ...overrides }),
      },
    });
  };

  it("asks the token endpoint for a new one and uses it", async () => {
    expired();
    tokenEndpoint({ access_token: "renewed", expires_in: 3600 });

    await expect(authHeadersForServer(SERVER)).resolves.toEqual({
      Authorization: "Bearer renewed",
    });
  });

  it("posts a form-encoded refresh grant to the recorded endpoint", async () => {
    expired();
    tokenEndpoint({ access_token: "renewed" });

    await authHeadersForServer(SERVER);

    const [url, init] = (
      globalThis.fetch as unknown as {
        mock: { calls: [string, RequestInit][] };
      }
    ).mock.calls[0]!;
    const body = new URLSearchParams(init.body as string);

    expect(url).toBe("https://auth.example.com/token");
    expect(init.method).toBe("POST");
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("stored-refresh");
    expect(body.get("client_id")).toBe("client-abc");
    // A public client has no secret, and sending an empty one is a 400.
    expect(body.has("client_secret")).toBe(false);
  });

  it("includes the client secret for a confidential client", async () => {
    expired({ clientSecret: "s3cret" });
    tokenEndpoint({ access_token: "renewed" });

    await authHeadersForServer(SERVER);

    const [, init] = (
      globalThis.fetch as unknown as {
        mock: { calls: [string, RequestInit][] };
      }
    ).mock.calls[0]!;

    expect(new URLSearchParams(init.body as string).get("client_secret")).toBe(
      "s3cret"
    );
  });

  it("stores the renewed token, so the next connect does not refresh again", async () => {
    expired();
    tokenEndpoint({ access_token: "renewed", expires_in: 3600 });
    await authHeadersForServer(SERVER);

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(authHeadersForServer(SERVER)).resolves.toEqual({
      Authorization: "Bearer renewed",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("takes a rotated refresh token, and keeps the old one otherwise", async () => {
    expired();
    tokenEndpoint({ access_token: "renewed", refresh_token: "rotated" });
    await authHeadersForServer(SERVER);
    expect(storedAuth().servers?.[SERVER]?.refreshToken).toBe("rotated");

    storeAuth({
      servers: {
        [SERVER]: record({
          expiresAt: Date.now() - 1_000,
          refreshToken: "kept",
        }),
      },
    });
    tokenEndpoint({ access_token: "renewed-again" });
    await authHeadersForServer(SERVER);

    expect(storedAuth().servers?.[SERVER]?.refreshToken).toBe("kept");
  });

  it("clears the expiry when the new token has none", async () => {
    // Leaving the old timestamp would make a token with no expiry look
    // permanently stale, refreshing on every single connect.
    expired();
    tokenEndpoint({ access_token: "renewed" });

    await authHeadersForServer(SERVER);

    expect(storedAuth().servers?.[SERVER]?.expiresAt).toBeUndefined();
  });

  it("records the scope the provider granted", async () => {
    expired({ scope: "read" });
    tokenEndpoint({ access_token: "renewed", scope: "read write" });

    await authHeadersForServer(SERVER);

    expect(storedAuth().servers?.[SERVER]?.scope).toBe("read write");
  });

  it("leaves other servers' tokens untouched", async () => {
    storeAuth({
      servers: {
        [SERVER]: record({ expiresAt: Date.now() - 1_000 }),
        "https://other.example.com": record({ accessToken: "other-access" }),
      },
    });
    tokenEndpoint({ access_token: "renewed" });

    await authHeadersForServer(SERVER);

    expect(
      storedAuth().servers?.["https://other.example.com"]?.accessToken
    ).toBe("other-access");
  });

  it("carries the registered clients through a refresh", async () => {
    // Never written here, but dropping them would cost the reuse of a
    // dynamically registered client on the next sign-in.
    storeAuth({
      servers: { [SERVER]: record({ expiresAt: Date.now() - 1_000 }) },
      clients: {
        "https://auth.example.com": {
          clientId: "client-abc",
          redirectUri: "http://127.0.0.1:1455/callback",
        },
      },
    });
    tokenEndpoint({ access_token: "renewed" });

    await authHeadersForServer(SERVER);

    expect(storedAuth().clients).toEqual({
      "https://auth.example.com": {
        clientId: "client-abc",
        redirectUri: "http://127.0.0.1:1455/callback",
      },
    });
  });
});

describe("when the renewal cannot be made", () => {
  const expiredRecord = (overrides: Partial<McpTokenRecord> = {}): void => {
    storeAuth({
      servers: {
        [SERVER]: record({ expiresAt: Date.now() - 1_000, ...overrides }),
      },
    });
  };

  /** Every unhappy ending is the same: no header, and a stale record kept. */
  const expectSilentFailure = async (): Promise<void> => {
    await expect(authHeadersForServer(SERVER)).resolves.toEqual({});
    // The stale record stays so the sign-in flow can still find the issuer.
    expect(storedAuth().servers?.[SERVER]?.accessToken).toBe("stored-access");
  };

  it("gives up on a record with no refresh token", async () => {
    expiredRecord({ refreshToken: undefined });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expectSilentFailure();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["a revoked grant", 400],
    ["an unauthorized client", 401],
    ["a server error", 500],
  ])("gives up when the provider answers with %s", async (_label, status) => {
    expiredRecord();
    tokenEndpoint({ error: "invalid_grant" }, { ok: false, status });

    await expectSilentFailure();
  });

  it("gives up when the token endpoint is unreachable", async () => {
    expiredRecord();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      })
    );

    await expectSilentFailure();
  });

  it("gives up when the response body is not JSON", async () => {
    expiredRecord();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      }))
    );

    await expectSilentFailure();
  });

  it.each([
    ["no access token", {}],
    ["an empty access token", { access_token: "" }],
    ["an access token that is not a string", { access_token: 42 }],
    ["a null body", null],
  ])("gives up on a 200 that carried %s", async (_label, body) => {
    expiredRecord();
    tokenEndpoint(body);

    await expectSilentFailure();
  });
});
