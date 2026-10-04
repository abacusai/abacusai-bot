import { createHash } from "node:crypto";

import { afterEach, expect, it, vi } from "vitest";
vi.mock("#main/services/providers/account-service", () => ({
  readAccountState: () => ({ account: null, apps: [], onboarded: true }),
}));
import { createWebAuth } from "./auth-web";
const setup = () => {
  const adoptAbacusCredential = vi.fn(async () => ({ ok: true }));
  return {
    adoptAbacusCredential,
    auth: createWebAuth({ adoptAbacusCredential } as never),
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
