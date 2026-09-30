/**
 * The app's own browser session for signing in and connecting: one Electron
 * partition, install-wide, beside the profile registry (userData lives inside
 * each account's profile, so a partition there would start empty after every
 * sign-out or account switch and no provider account could be remembered).
 *
 * It holds at most one Abacus.AI account, and this module is the one place
 * that knows which: the in-app sign-in records it, and a browser sign-in, a
 * pasted key or a sign-out clears it. A connector hop that wants to ride on
 * the session asks `sessionHolds(email)` for the app's current account, never
 * "are there cookies": the partition once carried account A's cookies into
 * account B's Gmail hop, and B's mailbox attached to A.
 */
import fs from "fs";
import path from "path";

import { session as electronSession } from "electron";

import { profileBaseDir } from "../../profile-home";
import { abacusAppHost } from "./abacus-host";

export const signInSessionPath = (): string =>
  path.join(profileBaseDir(), "sign-in-session");

const accountMarkerPath = (): string =>
  path.join(signInSessionPath(), "account.json");

export const signInSession = (): Electron.Session =>
  electronSession.fromPath(signInSessionPath());

const isAbacusHost = (domain: string | undefined): boolean => {
  const host = (domain ?? "").replace(/^\./, "").toLowerCase();
  return host === "abacus.ai" || host.endsWith(".abacus.ai");
};

/** Drop Abacus.AI's cookies and storage, keeping every provider's login. */
export const forgetAbacusSession = async (
  target: Electron.Session = signInSession()
): Promise<void> => {
  const cookies = await target.cookies.get({});
  await Promise.all(
    cookies
      .filter(({ domain }) => isAbacusHost(domain))
      .map(({ domain, path: cookiePath, name, secure }) =>
        target.cookies.remove(
          `${secure === true ? "https" : "http"}://${(domain ?? "").replace(/^\./, "")}${cookiePath ?? "/"}`,
          name
        )
      )
  );
  const storages: Array<
    "localstorage" | "indexdb" | "serviceworkers" | "cachestorage"
  > = ["localstorage", "indexdb", "serviceworkers", "cachestorage"];
  // The host the app is pointed at as well as the defaults: a preprod
  // session left in storage would survive a sign-out otherwise.
  const origins = new Set([
    "https://abacus.ai",
    "https://apps.abacus.ai",
    new URL(abacusAppHost()).origin,
  ]);
  for (const origin of origins)
    await target.clearStorageData({ origin, storages });
};

/** The account the in-app sign-in just signed in as: the partition is theirs. */
export const rememberSessionAccount = (email: string): void => {
  fs.mkdirSync(signInSessionPath(), { recursive: true });
  fs.writeFileSync(
    accountMarkerPath(),
    JSON.stringify({ email: email.trim().toLowerCase() }),
    { mode: 0o600 }
  );
};

/** Whose session the partition holds, or null when unknown. */
export const sessionAccount = (): string | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(accountMarkerPath(), "utf8")) as {
      email?: unknown;
    };
    return typeof parsed.email === "string" && parsed.email.length > 0
      ? parsed.email
      : null;
  } catch {
    return null;
  }
};

/**
 * Whether the partition holds a live session for exactly this account. Both
 * halves matter: the marker without cookies is a session that expired, and
 * cookies without the marker (a page load's Cloudflare cookie, a sign-in
 * that was handed off to the browser) are not a sign-in.
 */
export const sessionHolds = async (
  email: string | null | undefined
): Promise<boolean> => {
  const wanted = (email ?? "").trim().toLowerCase();
  if (wanted.length === 0 || sessionAccount() !== wanted) return false;
  const cookies = await signInSession().cookies.get({});
  return cookies.some(({ domain }) => isAbacusHost(domain));
};

/** Sign-out, a browser sign-in, a pasted key: the partition is nobody's now. */
export const clearSignInSession = async (): Promise<void> => {
  try {
    fs.rmSync(accountMarkerPath(), { force: true });
  } catch {
    // A missing marker is the state we want.
  }
  await forgetAbacusSession();
};
