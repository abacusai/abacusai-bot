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

import {
  allowedExternalSchemes,
  isSafeExternalUrl,
  withUpgradeReturn,
} from "./external-links";

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

describe("withUpgradeReturn", () => {
  const host = "https://apps.abacus.ai";

  it("asks the bot's upgrade page to open the app again once paid", () => {
    // A minted link (a button) and the plain page (a link in a chat reply).
    expect(
      withUpgradeReturn("https://apps.abacus.ai/bot/link/upgrade?r=abc", host)
    ).toBe("https://apps.abacus.ai/bot/link/upgrade?r=abc&back=desktop");
    expect(
      withUpgradeReturn(
        "https://apps.abacus.ai/bot/link/upgrade?src=billing_plan",
        host
      )
    ).toBe(
      "https://apps.abacus.ai/bot/link/upgrade?src=billing_plan&back=desktop"
    );
  });

  it("tags a link once, however many openers it passes", () => {
    const once = withUpgradeReturn(
      "https://apps.abacus.ai/bot/link/upgrade?r=abc",
      host
    );
    expect(withUpgradeReturn(once, host)).toBe(once);
  });

  it("follows the app host the app is pointed at", () => {
    expect(
      withUpgradeReturn(
        "https://preprod-apps.abacus.ai/bot/link/upgrade",
        "https://preprod-apps.abacus.ai"
      )
    ).toBe("https://preprod-apps.abacus.ai/bot/link/upgrade?back=desktop");
  });

  it("leaves every other link alone", () => {
    for (const url of [
      "https://apps.abacus.ai/chatllm/admin/billing",
      "https://evil.example/bot/link/upgrade",
      "https://apps.abacus.ai.evil.example/bot/link/upgrade",
      "mailto:someone@abacus.ai",
      "not a url",
    ])
      expect(withUpgradeReturn(url, host)).toBe(url);
  });
});
