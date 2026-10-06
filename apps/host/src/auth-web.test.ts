import { createHash } from "node:crypto";

import { afterEach, expect, it, vi } from "vitest";
vi.mock("#main/services/providers/account-service", () => ({
  readAccountState: () => ({ account: null, apps: [], onboarded: true }),
}));
import { createWebAuth } from "./auth-web";
const setup = () => {
  const adoptAbacusCredential = vi.fn(
    async (): Promise<{ ok: boolean; accountDetailsPending?: boolean }> => ({
      ok: true,
    })
  );
  return {
    adoptAbacusCredential,
    auth: createWebAuth(adoptAbacusCredential as never),
  };
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("keeps the verifier on the host, exchanges the code, and adopts only the returned bot key", async () => {
  const { auth, adoptAbacusCredential } = setup();
  const fetch = vi.fn(async (_url: string, _options: RequestInit) =>
    Response.json({ success: true, result: { apiKey: "bot-key" } })
  );
  vi.stubGlobal("fetch", fetch);
  const { challenge } = await auth.start();
  expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await auth.complete({ code: "once" })).toMatchObject({
    onboarded: true,
  });
  const options = fetch.mock.calls[0][1] as RequestInit;
  const body = JSON.parse(options.body as string);
  expect(body).toMatchObject({ authCode: "once", signinVariant: "web" });
  expect(createHash("sha256").update(body.verifier).digest("base64url")).toBe(
    challenge
  );
  expect(adoptAbacusCredential).toHaveBeenCalledWith("bot-key", "web");
  await expect(auth.complete({ code: "once" })).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
});
it("expires pending verifiers after ten minutes and never adopts a rejected exchange", async () => {
  const { auth, adoptAbacusCredential } = setup();
  let now = 1;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await auth.start();
  now += 600_001;
  await expect(auth.complete({ code: "expired" })).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 403 }))
  );
  await auth.start();
  await expect(auth.complete({ code: "rejected" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  expect(adoptAbacusCredential).not.toHaveBeenCalled();
});

it("returns a typed pending success after an exchanged key is retained", async () => {
  const { auth, adoptAbacusCredential } = setup();
  adoptAbacusCredential.mockResolvedValue({
    ok: true,
    accountDetailsPending: true,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ apiKey: "bot-key" }))
  );
  await auth.start();
  expect(await auth.complete({ code: "once" })).toEqual({
    account: null,
    apps: [],
    onboarded: true,
    accountDetailsPending: true,
  });
});
it("rejects a key explicitly refused during adoption", async () => {
  const { auth, adoptAbacusCredential } = setup();
  adoptAbacusCredential.mockResolvedValue({ ok: false });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ apiKey: "bot-key" }))
  );
  await auth.start();
  await expect(auth.complete({ code: "once" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
});

it("adopts a server-provisioned key through the browser sign-in path, then deletes it", async () => {
  const { adoptProvisionedKey } = await import("./auth-web");
  const { mkdtempSync, writeFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const file = join(mkdtempSync(join(tmpdir(), "key-")), "provisioned-key");
  writeFileSync(file, "s2_0123456789abcdef0123456789abcdef\n", { mode: 0o600 });
  let signedIn = false;
  const adopt = vi.fn(async () => {
    signedIn = true;
    return { ok: true as const };
  });
  expect(await adoptProvisionedKey(file, () => signedIn, adopt)).toBe(true);
  expect(adopt).toHaveBeenCalledWith(
    "s2_0123456789abcdef0123456789abcdef",
    "web"
  );
  expect(existsSync(file)).toBe(false);
});

it("never adopts over a signed-in host, a malformed key, or a refused one", async () => {
  const { adoptProvisionedKey } = await import("./auth-web");
  const { mkdtempSync, writeFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "key-"));
  const adopt = vi.fn(async () => ({
    ok: false as const,
    error: "unidentified-account" as const,
  }));
  const log = vi.fn();
  for (const [content, signedIn] of [
    ["s2_0123456789abcdef0123456789abcdef", true],
    ["not a key; rm -rf /", false],
    ["s2_0123456789abcdef0123456789abcdef", false],
  ] as const) {
    const file = join(dir, "provisioned-key");
    writeFileSync(file, content);
    await adoptProvisionedKey(file, () => signedIn, adopt as never, log);
    expect(existsSync(file)).toBe(false);
  }
  expect(adopt).toHaveBeenCalledTimes(1);
  expect(log.mock.calls.flat().join(" ")).not.toContain("s2_0123456789abcdef");
  expect(
    await adoptProvisionedKey(join(dir, "missing"), () => false, adopt as never)
  ).toBe(false);
});
