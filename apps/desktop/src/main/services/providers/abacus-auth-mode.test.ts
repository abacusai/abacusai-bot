/**
 * Which form the browser opens on, and getting back to a lost tab. An
 * existing account holder sent to the sign-up form is a funnel leak, so the
 * form follows the button the user pressed.
 */
import { shell } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, focus: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

const openExternal = vi.mocked(shell.openExternal);

const { startAbacusAuth, cancelAbacusAuth, reopenAbacusAuth } =
  await import("./abacus-auth-service");

/** The page the last attempt opened, once its listener is up. */
const openedUrl = async (): Promise<URL> => {
  await vi.waitFor(() => expect(openExternal).toHaveBeenCalled());

  return new URL(openExternal.mock.calls.at(-1)?.[0] ?? "");
};

beforeEach(() => {
  openExternal.mockReset();
  openExternal.mockResolvedValue(undefined);
});

afterEach(() => {
  cancelAbacusAuth();
});

describe("the page an Abacus.AI sign-in opens", () => {
  it("is the sign-up form when the user asked to sign up", async () => {
    void startAbacusAuth("signup");

    expect((await openedUrl()).searchParams.get("isSignUp")).toBe("1");
  });

  it("is the sign-in form otherwise, since most callers already have an account", async () => {
    void startAbacusAuth();

    const url = await openedUrl();

    expect(url.searchParams.has("isSignUp")).toBe(false);
    expect(url.searchParams.get("AbacusAIBot")).toBe("1");
  });
});

describe("reopening the browser page", () => {
  it("opens the waiting attempt's page again rather than starting another", async () => {
    void startAbacusAuth("signup");
    const first = (await openedUrl()).toString();

    reopenAbacusAuth();

    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(openExternal.mock.calls[1]?.[0]).toBe(first);
  });

  it("does nothing once no sign-in is waiting", async () => {
    void startAbacusAuth();
    await openedUrl();
    cancelAbacusAuth();

    reopenAbacusAuth();

    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});
