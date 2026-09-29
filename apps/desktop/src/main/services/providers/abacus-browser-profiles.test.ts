/**
 * Which Chromium profiles the sign-in screen offers: only in the in-app arm,
 * only profiles whose cookie store names Abacus.AI, and only a few. Listing
 * never reads a cookie; that waits for the user to pick one.
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
const readProfileCookies = vi.fn(async () => [
  { name: "auth", value: "v", domain: ".abacus.ai" },
]);
vi.mock("../browser/browser-profiles-service", () => ({
  discoverBrowserProfiles: () => profiles,
  profileMentionsHost: async (p: { hasAbacus: boolean }) => p.hasAbacus,
  readProfileCookies: (...args: unknown[]) => readProfileCookies(...args),
}));

const { listBrowserSignInProfiles, browserSignInCookies } =
  await import("./abacus-browser-profiles");

beforeEach(() => {
  variant = "in_app";
  profiles = [profile("Default", true), profile("Profile 1", false)];
  readProfileCookies.mockClear();
});

describe("the profiles offered at sign-in", () => {
  it("are the ones with an Abacus.AI cookie, without reading any cookie", async () => {
    const offered = await listBrowserSignInProfiles();

    expect(offered.map((p) => p.id)).toEqual(["Default"]);
    expect(readProfileCookies).not.toHaveBeenCalled();
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
