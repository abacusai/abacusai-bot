/**
 * What may be handed to the OS as an external link.
 *
 * `shell.openExternal` dispatches on the scheme, so the reachable set is every
 * protocol handler on the machine, and the URLs reaching it are not all ours.
 * The preview pane's "open externally" button passes the webview's current
 * location, and a webview renders HTML the agent wrote, from whatever the agent
 * was reading. Before this the URL was passed through unread.
 */
import { describe, expect, it } from "vitest";

import { allowedExternalSchemes, isSafeExternalUrl } from "./external-links";

describe("isSafeExternalUrl", () => {
  it("allows the schemes a link button is for", () => {
    expect(isSafeExternalUrl("https://abacus.ai")).toBe(true);
    expect(isSafeExternalUrl("http://127.0.0.1:5173/preview")).toBe(true);
    expect(isSafeExternalUrl("mailto:someone@abacus.ai")).toBe(true);
  });

  it("refuses to hand the OS a local path", () => {
    // `file:` is how an external-link button becomes "open anything on this
    // disk with its registered application".
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("file:///C:/Windows/System32/calc.exe")).toBe(
      false
    );
  });

  it("refuses script and data URLs", () => {
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("data:text/html,<script>alert(1)</script>")).toBe(
      false
    );
    expect(isSafeExternalUrl("vbscript:msgbox(1)")).toBe(false);
  });

  it("refuses application schemes the OS may route to a program", () => {
    // The Windows long tail: schemes registered by installed software, some of
    // which take arguments amounting to "run this".
    expect(isSafeExternalUrl("ms-msdt:/id PCWDiagnostic")).toBe(false);
    expect(isSafeExternalUrl("search-ms:query=x")).toBe(false);
    expect(isSafeExternalUrl("smb://attacker/share")).toBe(false);
  });

  it("decides on the parsed scheme, not on how the string reads", () => {
    // A prefix check is what these defeat: the first two are not http URLs at
    // all, and the third only looks like one to a substring match.
    expect(isSafeExternalUrl('javascript:void(location="https://x")')).toBe(
      false
    );
    expect(isSafeExternalUrl(" javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("file:///x#https://abacus.ai")).toBe(false);
  });

  it("refuses anything that is not a parseable URL", () => {
    expect(isSafeExternalUrl("")).toBe(false);
    expect(isSafeExternalUrl("not a url")).toBe(false);
    expect(isSafeExternalUrl("//abacus.ai")).toBe(false);
    expect(isSafeExternalUrl(undefined)).toBe(false);
    expect(isSafeExternalUrl(null)).toBe(false);
    expect(isSafeExternalUrl(42)).toBe(false);
    expect(isSafeExternalUrl({ toString: () => "https://abacus.ai" })).toBe(
      false
    );
  });

  it("is case-insensitive about the scheme, because the URL parser is", () => {
    expect(isSafeExternalUrl("HTTPS://abacus.ai")).toBe(true);
    expect(isSafeExternalUrl("JavaScript:alert(1)")).toBe(false);
  });

  it("keeps the allowlist to what a link button needs", () => {
    expect(allowedExternalSchemes().sort()).toEqual([
      "http:",
      "https:",
      "mailto:",
    ]);
  });
});
