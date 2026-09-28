import fs from "fs";
import path from "path";

import { EMPTY_ACCOUNT_STATE, type AccountState } from "#shared/account";

import { abacusBotHome } from "../../paths";

/**
 * The account file: `~/.abacusai-bot/account.json`. With no server there is
 * no session to refresh. The file being present *is* being signed in.
 */

const accountPath = (): string => path.join(abacusBotHome(), "account.json");

export const readAccountState = (): AccountState => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(accountPath(), "utf8"));

    if (parsed == null || typeof parsed !== "object")
      return EMPTY_ACCOUNT_STATE;

    return { ...EMPTY_ACCOUNT_STATE, ...(parsed as AccountState) };
  } catch {
    return EMPTY_ACCOUNT_STATE;
  }
};

const writeAccountState = (state: AccountState): AccountState => {
  const target = accountPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  // 0600: it holds an email address, and nothing else on the machine needs it.
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Windows and some network filesystems don't do POSIX modes. Not fatal.
  }

  return state;
};

/** Dismiss onboarding; recorded so the flow does not reappear every launch. */
export const skipOnboarding = (): AccountState =>
  writeAccountState({ ...readAccountState(), onboarded: true });

/**
 * Forget who is signed in, but keep `onboarded`: the file lives in the
 * account's own profile, so a returning account must not redo first-run.
 */
export const signOut = (): AccountState => {
  const { onboarded } = readAccountState();
  if (!onboarded) return forgetAccount();
  return writeAccountState({ ...EMPTY_ACCOUNT_STATE, onboarded: true });
};

/** Forget everything, onboarding included. The next launch starts over. */
export const forgetAccount = (): AccountState => {
  try {
    fs.rmSync(accountPath(), { force: true });
  } catch {
    // Already gone, or unwritable. Either way there is nothing to report.
  }

  return EMPTY_ACCOUNT_STATE;
};
