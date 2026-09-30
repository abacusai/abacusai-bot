/**
 * The user's own browser applied to the sign-in window. The OS default
 * browser's default profile comes first: its Abacus.AI session makes a
 * returning user's sign-in one click, and its Google, Microsoft, Apple and
 * GitHub sessions let a new user pick an account in the provider popup
 * instead of typing a password there.
 *
 * Listing reads no cookie: a profile is offered when its cookie database
 * names abacus.ai, which is stored in the clear. Safari and Firefox keep
 * their cookies out of reach; their users sign in through the browser.
 */
import type { BrowserSignInProfile } from "#shared/contracts";

import {
  discoverBrowserProfiles,
  findDefaultBrowser,
  profileMentionsHost,
  readProfileCookies,
  type BrowserProfileInfo,
  type CDPCookie,
} from "../browser/browser-profiles-service";
import { abacusAppHost, isHostOverridden } from "./abacus-host";
import { resolveSignInVariant } from "./abacus-signin-config";

const ABACUS_DOMAIN = "abacus.ai";

// A short list reads as a choice; a long one as a settings page.
const MAX_PROFILES = 3;

/**
 * What the provider login pages would be sent, and nothing else: the account
 * choosers read these, so a signed-in provider asks for one click.
 */
export const PROVIDER_LOGIN_URLS = [
  "https://accounts.google.com/",
  "https://login.microsoftonline.com/",
  "https://login.live.com/",
  "https://appleid.apple.com/",
  "https://idmsa.apple.com/",
  "https://github.com/login",
];

const toSignInProfile = (
  profile: BrowserProfileInfo,
  extra: Partial<BrowserSignInProfile>
): BrowserSignInProfile => ({
  id: profile.id,
  browserName: profile.browserName,
  profileName: profile.profileName,
  ...extra,
});

/**
 * For installs in the in-app arm (the browser arm signs in where these
 * sessions already live): the default browser's default profile, whether or
 * not it holds an Abacus.AI session, then other profiles that may.
 */
export const listBrowserSignInProfiles = async (): Promise<
  BrowserSignInProfile[]
> => {
  if ((await resolveSignInVariant()) !== "in_app") return [];

  const profiles = discoverBrowserProfiles();
  const defaultProfile = (await findDefaultBrowser(profiles))?.profile ?? null;

  const offered: BrowserSignInProfile[] = [];
  if (defaultProfile != null) {
    offered.push(
      toSignInProfile(defaultProfile, {
        isDefault: true,
        hasAbacusSession: await profileMentionsHost(
          defaultProfile,
          ABACUS_DOMAIN
        ),
      })
    );
  }
  for (const profile of profiles) {
    if (offered.filter((p) => p.hasAbacusSession).length >= MAX_PROFILES) break;
    if (profile.id === defaultProfile?.id) continue;
    if (await profileMentionsHost(profile, ABACUS_DOMAIN))
      offered.push(toSignInProfile(profile, { hasAbacusSession: true }));
  }
  return offered;
};

const readCookies = async (
  profile: BrowserProfileInfo,
  urls: string[]
): Promise<CDPCookie[] | null> => {
  try {
    return await readProfileCookies(profile, urls);
  } catch (error) {
    console.warn(
      `[abacus-auth] could not read ${profile.browserName} cookies: ${error instanceof Error ? error.message : "unknown"}`
    );
    return null;
  }
};

/** The Abacus.AI cookies of a profile the user picked; empty when unreadable. */
export const browserSignInCookies = async (
  profileId: string
): Promise<CDPCookie[]> => {
  const profile = discoverBrowserProfiles().find((p) => p.id === profileId);
  if (profile == null) return [];
  // Pointed at another host (a test build on preprod), only that host's
  // cookies: a production session seeded beside them would be sent to it.
  const origin = new URL(abacusAppHost()).origin;
  return (
    (await readCookies(
      profile,
      isHostOverridden() ? [origin] : [`https://${ABACUS_DOMAIN}/`, origin]
    )) ?? []
  );
};

/** The default browser's default profile, when this module can read it. */
export const defaultSignInProfile =
  async (): Promise<BrowserProfileInfo | null> =>
    (await findDefaultBrowser())?.profile ?? null;

/**
 * The provider login cookies of `profile`: null when the browser would not
 * hand them over, so the caller can send provider sign-ins to the browser.
 */
export const providerSignInCookies = (
  profile: BrowserProfileInfo
): Promise<CDPCookie[] | null> => readCookies(profile, PROVIDER_LOGIN_URLS);
