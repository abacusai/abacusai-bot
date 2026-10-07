/**
 * The authorization endpoint arrives in a .well-known document the MCP server
 * itself serves, and it ends up in `shell.openExternal`. A hostile server must
 * not be able to turn "sign in" into opening an arbitrary protocol handler.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  exchangeCode,
  isHttpAuthorizationEndpoint,
  mcpTokenState,
} from "./mcp-oauth-service";

describe("isHttpAuthorizationEndpoint", () => {
  it("allows the web URLs a sign-in page lives at", () => {
    expect(isHttpAuthorizationEndpoint("https://auth.abacus.ai/oauth")).toBe(
      true
    );
    expect(isHttpAuthorizationEndpoint("http://127.0.0.1:8080/authorize")).toBe(
      true
    );
  });

  it("refuses schemes that reach beyond the browser", () => {
    expect(isHttpAuthorizationEndpoint("file:///etc/passwd")).toBe(false);
    expect(isHttpAuthorizationEndpoint("javascript:alert(1)")).toBe(false);
    expect(isHttpAuthorizationEndpoint("vbscript:msgbox(1)")).toBe(false);
    // The long tail of app schemes the OS may route to a program.
    expect(isHttpAuthorizationEndpoint("ms-msdt:/id PCWDiagnostic")).toBe(
      false
    );
    expect(isHttpAuthorizationEndpoint("smb://attacker/share")).toBe(false);
  });

  it("refuses anything that is not a parseable URL string", () => {
    expect(isHttpAuthorizationEndpoint("")).toBe(false);
    expect(isHttpAuthorizationEndpoint("not a url")).toBe(false);
    expect(isHttpAuthorizationEndpoint(undefined)).toBe(false);
    expect(isHttpAuthorizationEndpoint(null)).toBe(false);
    expect(isHttpAuthorizationEndpoint(42)).toBe(false);
  });

  it("decides on the parsed scheme, case included", () => {
    expect(isHttpAuthorizationEndpoint("HTTPS://auth.abacus.ai")).toBe(true);
    expect(isHttpAuthorizationEndpoint("JavaScript:alert(1)")).toBe(false);
  });
});

describe("mcpTokenState", () => {
  const url = "https://mcp.example/mcp";
  const record = (fields: Record<string, unknown>) => ({
    servers: {
      [url]: { tokenEndpoint: "https://t", clientId: "c", ...fields },
    },
  });
  const homeWith = (file: unknown): string => {
    const home = mkdtempSync(join(tmpdir(), "mcp-token-"));
    writeFileSync(join(home, "mcp-auth.json"), JSON.stringify(file));
    vi.stubEnv("ABACUSAI_BOT_HOME", home);
    return home;
  };
  const homes: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const home of homes.splice(0))
      rmSync(home, { recursive: true, force: true });
  });

  it("is valid unexpired or renewable, expired past expiry without a refresh token, absent without a token", () => {
    const now = 1_000_000_000;
    const cases = [
      [{ accessToken: "a" }, "valid"],
      [{ accessToken: "a", expiresAt: now + 3_600_000 }, "valid"],
      [{ accessToken: "a", expiresAt: now - 1 }, "expired"],
      // Inside the agent's refresh skew, it is not sent as is.
      [{ accessToken: "a", expiresAt: now + 30_000 }, "expired"],
      [{ accessToken: "a", expiresAt: now - 1, refreshToken: "r" }, "valid"],
      [{ accessToken: "" }, "absent"],
    ] as const;
    for (const [fields, state] of cases) {
      homes.push(homeWith(record(fields)));
      expect(mcpTokenState(url, now)).toBe(state);
    }
    homes.push(homeWith({}));
    expect(mcpTokenState(url, now)).toBe("absent");
  });

  it("reads the file once, and again only after a write", async () => {
    const home = homeWith({});
    homes.push(home);
    expect(mcpTokenState(url)).toBe("absent");
    // Changed behind its back: the cached read stands.
    writeFileSync(
      join(home, "mcp-auth.json"),
      JSON.stringify(record({ accessToken: "a" }))
    );
    expect(mcpTokenState(url)).toBe("absent");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ access_token: "b" })
    );
    await exchangeCode({
      serverUrl: url,
      metadata: { token_endpoint: "https://t" },
      client: { clientId: "c" },
      code: "code",
      redirectUri: "https://r",
      verifier: "v",
    });
    expect(mcpTokenState(url)).toBe("valid");
  });
});
