/**
 * The sign-in window remembers provider sessions, so Microsoft's popup is
 * asked for its account picker instead of silently reusing the last account.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

const { withMicrosoftAccountPicker } = await import("./abacus-signin-window");

describe("Microsoft's account picker", () => {
  it("is forced on for Microsoft's authorize page", () => {
    const url = withMicrosoftAccountPicker(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x&state=y"
    );

    expect(new URL(String(url)).searchParams.get("prompt")).toBe(
      "select_account"
    );
    expect(new URL(String(url)).searchParams.get("state")).toBe("y");
  });

  it.each([
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?prompt=login",
    "https://appleid.apple.com/auth/authorize?client_id=x",
    "https://login.microsoftonline.com.evil.example/common/oauth2/v2.0/authorize",
    "about:blank",
  ])("leaves anything else alone (%s)", (url) => {
    expect(withMicrosoftAccountPicker(url)).toBeNull();
  });
});
