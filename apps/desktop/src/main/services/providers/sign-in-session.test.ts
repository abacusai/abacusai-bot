import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const partition = vi.hoisted(() => ({
  cookies: [] as Array<{ domain: string; path: string; name: string }>,
  removed: [] as string[],
  cleared: [] as string[],
}));
vi.mock("electron", () => ({
  session: {
    fromPath: () => ({
      cookies: {
        get: async () => partition.cookies,
        remove: async (url: string, name: string) => {
          partition.removed.push(`${name}@${url}`);
        },
      },
      clearStorageData: async ({ origin }: { origin: string }) => {
        partition.cleared.push(origin);
      },
    }),
  },
}));
let base = "";
vi.mock("../../profile-home", () => ({ profileBaseDir: () => base }));
vi.mock("./abacus-host", () => ({
  abacusAppHost: () => "https://preprod.example.abacus.ai",
}));

const {
  clearSignInSession,
  rememberSessionAccount,
  sessionAccount,
  sessionHolds,
} = await import("./sign-in-session");

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "sign-in-session-"));
  partition.cookies = [];
  partition.removed = [];
  partition.cleared = [];
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("whose session the partition holds", () => {
  it("is nobody's until an in-app sign-in says whose, cookies or not", async () => {
    partition.cookies = [{ domain: ".abacus.ai", path: "/", name: "__cf_bm" }];

    expect(sessionAccount()).toBeNull();
    expect(await sessionHolds("a@example.com")).toBe(false);
  });

  it("is that account's, and no other's, while its cookies are there", async () => {
    rememberSessionAccount("A@Example.com");
    partition.cookies = [{ domain: ".abacus.ai", path: "/", name: "sid" }];

    expect(await sessionHolds("a@example.com")).toBe(true);
    expect(await sessionHolds("b@example.com")).toBe(false);
    // The marker alone is a session that expired.
    partition.cookies = [];
    expect(await sessionHolds("a@example.com")).toBe(false);
  });

  it("is cleared with its cookies and storage, on the app's host too", async () => {
    rememberSessionAccount("a@example.com");
    partition.cookies = [
      { domain: ".abacus.ai", path: "/", name: "sid" },
      { domain: "accounts.google.com", path: "/", name: "keep" },
    ];

    await clearSignInSession();

    expect(sessionAccount()).toBeNull();
    expect(partition.removed).toEqual(["sid@http://abacus.ai/"]);
    expect(partition.cleared).toContain("https://preprod.example.abacus.ai");
    expect(partition.cleared).toContain("https://apps.abacus.ai");
  });
});
