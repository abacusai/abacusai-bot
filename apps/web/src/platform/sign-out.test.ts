import { expect, it, vi } from "vitest";

import type { RouterContext } from "#renderer/router";

import { signOutAbacus } from "./sign-out.electron";

it("keeps desktop key removal, local sign-out and credential invalidation in order", async () => {
  const events: unknown[] = [];
  const context = {
    transport: {
      client: {
        auth: {
          abacus: { signOut: async (input: unknown) => events.push(input) },
        },
        account: { signOut: async () => events.push("account") },
      },
    },
    credentialsChanged: async () => events.push("credentials"),
  } as unknown as RouterContext;
  await signOutAbacus(context, false);
  expect(events).toEqual([
    { keepOtherApiKeys: false },
    "account",
    "credentials",
  ]);
});

it("does not clear the desktop account when removing its key fails", async () => {
  const signOut = vi.fn();
  const context = {
    transport: {
      client: {
        auth: {
          abacus: {
            signOut: async () => {
              throw new Error("key removal failed");
            },
          },
        },
        account: { signOut },
      },
    },
    credentialsChanged: vi.fn(),
  } as unknown as RouterContext;
  await expect(signOutAbacus(context, true)).rejects.toThrow(
    "key removal failed"
  );
  expect(signOut).not.toHaveBeenCalled();
  expect(context.credentialsChanged).not.toHaveBeenCalled();
});
