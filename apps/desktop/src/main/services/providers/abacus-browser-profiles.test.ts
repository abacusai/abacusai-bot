/**
 * Which Chromium profiles the sign-in screen offers: only in the in-app arm,
 * the default browser's profile first, then a few whose cookie store names
 * Abacus.AI. Listing never reads a cookie; that waits for the user to pick one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: true } }));

let variant: "in_app" | "browser" = "in_app";
vi.mock("./abacus-signin-config", () => ({
  resolveSignInVariant: async () => variant,
}));

const profile = (id: string, hasAbacus: boolean) => ({
  id,
  browserName: "Chrome",
  browserKey: "chrome",
  profileName: id,
  profileDir: id,
  profileDataPath: `/profiles/${id}`,
  hasAbacus,
});
let profiles = [profile("Default", true), profile("Profile 1", false)];
const readProfileCookies = vi.fn(async (..._args: unknown[]) => [
  { name: "auth", value: "v", domain: ".abacus.ai" },
]);
let defaultId: string | null = null;
vi.mock("../browser/browser-profiles-service", () => ({
  discoverBrowserProfiles: () => profiles,
  findDefaultBrowser: async () => ({
    handlerName: "Google Chrome",
    profile: profiles.find((p) => p.id === defaultId) ?? null,
  }),
  profileMentionsHost: async (p: { hasAbacus: boolean }) => p.hasAbacus,
  readProfileCookies: (...args: unknown[]) => readProfileCookies(...args),
}));

const {
  listBrowserSignInProfiles,
  browserSignInCookies,
  providerSignInCookies,
  PROVIDER_LOGIN_URLS,
} = await import("./abacus-browser-profiles");

beforeEach(() => {
  variant = "in_app";
  profiles = [profile("Default", true), profile("Profile 1", false)];
  defaultId = null;
  readProfileCookies.mockClear();
});

describe("the profiles offered at sign-in", () => {
  it("are the ones with an Abacus.AI cookie, without reading any cookie", async () => {
    const offered = await listBrowserSignInProfiles();

    expect(offered.map((p) => p.id)).toEqual(["Default"]);
    expect(readProfileCookies).not.toHaveBeenCalled();
  });

  it("start with the default browser's profile, signed in to Abacus.AI or not", async () => {
    defaultId = "Profile 1";

    expect(await listBrowserSignInProfiles()).toEqual([
      expect.objectContaining({
        id: "Profile 1",
        isDefault: true,
        hasAbacusSession: false,
      }),
      expect.objectContaining({ id: "Default", hasAbacusSession: true }),
    ]);
    expect(readProfileCookies).not.toHaveBeenCalled();
  });

  it("list the default profile once when it holds the session", async () => {
    defaultId = "Default";

    const offered = await listBrowserSignInProfiles();

    expect(offered.map((p) => p.id)).toEqual(["Default"]);
    expect(offered[0]).toMatchObject({
      isDefault: true,
      hasAbacusSession: true,
    });
  });

  it("are none outside the in-app arm", async () => {
    variant = "browser";

    expect(await listBrowserSignInProfiles()).toEqual([]);
  });

  it("stay a short list", async () => {
    profiles = Array.from({ length: 6 }, (_, i) => profile(`P${i}`, true));

    expect((await listBrowserSignInProfiles()).length).toBeLessThanOrEqual(3);
  });
});

describe("a picked profile", () => {
  it("hands over its Abacus.AI cookies", async () => {
    expect(await browserSignInCookies("Default")).toHaveLength(1);
  });

  it("hands over nothing for an unknown id or a failed read", async () => {
    expect(await browserSignInCookies("nope")).toEqual([]);

    readProfileCookies.mockRejectedValueOnce(new Error("locked"));
    expect(await browserSignInCookies("Default")).toEqual([]);
  });
});

describe("the default profile's provider sessions", () => {
  it("are read for the provider login pages only", async () => {
    await providerSignInCookies(profiles[0]!);

    expect(readProfileCookies).toHaveBeenCalledWith(
      profiles[0],
      PROVIDER_LOGIN_URLS
    );
  });

  it("are null, not empty, when the browser will not hand them over", async () => {
    readProfileCookies.mockRejectedValueOnce(new Error("locked"));

    expect(await providerSignInCookies(profiles[0]!)).toBeNull();
  });
});
