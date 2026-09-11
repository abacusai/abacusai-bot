/**
 * Signing out forgets who was signed in, not that they finished onboarding.
 *
 * The account file is per profile, and a profile is one Abacus account, so
 * `onboarded` there is that account's answer. Sign-out used to delete the
 * file, and the same account's next sign-in was walked through the whole
 * first-run flow again. A new account has a fresh profile and no file, which
 * is what still owes it the flow.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { forgetAccount, readAccountState, signOut, skipOnboarding } =
  await import("./account-service");

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-account-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  delete process.env.ABACUSAI_BOT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("signing out", () => {
  it("keeps the onboarded answer for the account's next sign-in", () => {
    skipOnboarding();
    expect(readAccountState().onboarded).toBe(true);

    const after = signOut();

    expect(after.account).toBeNull();
    expect(after.onboarded).toBe(true);
    expect(readAccountState().onboarded).toBe(true);
  });

  it("leaves nothing behind for a profile that never finished onboarding", () => {
    const after = signOut();

    expect(after.onboarded).toBe(false);
    expect(fs.existsSync(path.join(home, "account.json"))).toBe(false);
  });
});

describe("forgetting the account", () => {
  it("owes the first-run flow again", () => {
    skipOnboarding();

    const after = forgetAccount();

    expect(after.onboarded).toBe(false);
    expect(readAccountState().onboarded).toBe(false);
  });
});
