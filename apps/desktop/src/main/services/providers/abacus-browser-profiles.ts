/**
 * "Continue with Chrome" on the sign-in screen, the in-app browser's profile
 * import applied to the sign-in window: the user picks a Chromium profile,
 * and only then does that browser hand over its Abacus.AI cookies, which go
 * into the sign-in window's session and nowhere else. The connect page then
 * finds the session it already has and finishes on its own.
 *
 * Listing reads no cookie: a profile is offered when its cookie database
 * names abacus.ai, which is stored in the clear. Safari and Firefox keep
 * their cookies out of reach; their users see the screen as it was.
 */
import type { BrowserSignInProfile } from "#shared/contracts";

import {
  discoverBrowserProfiles,
  profileMentionsHost,
  readProfileCookies,
  type CDPCookie,
} from "../browser/browser-profiles-service";
import { abacusAppHost } from "./abacus-host";
import { resolveSignInVariant } from "./abacus-signin-config";

const ABACUS_DOMAIN = "abacus.ai";

// A short list reads as a choice; a long one as a settings page.
const MAX_PROFILES = 3;

/**
 * Profiles that may hold an Abacus.AI session, for installs in the in-app
 * arm: the browser arm signs in where those sessions already live.
 */
export const listBrowserSignInProfiles = async (): Promise<
  BrowserSignInProfile[]
> => {
  if ((await resolveSignInVariant()) !== "in_app") return [];

  const offered: BrowserSignInProfile[] = [];
  for (const profile of discoverBrowserProfiles()) {
    if (offered.length >= MAX_PROFILES) break;
    if (await profileMentionsHost(profile, ABACUS_DOMAIN)) {
      offered.push({
        id: profile.id,
        browserName: profile.browserName,
        profileName: profile.profileName,
      });
    }
  }
  return offered;
};

/** The Abacus.AI cookies of a profile the user picked; empty when unreadable. */
export const browserSignInCookies = async (
  profileId: string
): Promise<CDPCookie[]> => {
  const profile = discoverBrowserProfiles().find((p) => p.id === profileId);
  if (profile == null) return [];
  try {
    return await readProfileCookies(profile, [
      `https://${ABACUS_DOMAIN}/`,
      new URL(abacusAppHost()).origin,
    ]);
  } catch (error) {
    console.warn(
      `[abacus-auth] could not read ${profile.browserName} cookies: ${error instanceof Error ? error.message : "unknown"}`
    );
    return [];
  }
};
