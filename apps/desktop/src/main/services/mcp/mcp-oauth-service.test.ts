/**
 * The authorization endpoint arrives in a .well-known document the MCP server
 * itself serves, and it ends up in `shell.openExternal`. A hostile server must
 * not be able to turn "sign in" into opening an arbitrary protocol handler.
 */
import { describe, expect, it } from "vitest";

import { isHttpAuthorizationEndpoint } from "./mcp-oauth-service";

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
