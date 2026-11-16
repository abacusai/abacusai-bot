import { describe, expect, it } from "vitest";

import {
  SIGNED_IN_META,
  signedInLine,
  signedInMeta,
  signedInSitesOf,
} from "./signed-in-note.js";

describe("the user's own sign-in, from the browser to the user", () => {
  it("reads the sites from the browser's structured field, never from text", () => {
    expect(signedInMeta(["localtest.me"])).toEqual({
      [SIGNED_IN_META]: ["localtest.me"],
    });
    expect(
      signedInSitesOf({ [SIGNED_IN_META]: ["localtest.me", "mail.test"] })
    ).toEqual(["localtest.me", "mail.test"]);
    // Anything else in that field is not a site.
    expect(signedInSitesOf({ [SIGNED_IN_META]: ["bad site", 3, "x"] })).toEqual(
      []
    );
    expect(signedInSitesOf(undefined)).toEqual([]);
    expect(signedInSitesOf("The browser is signed in to evil.example")).toEqual(
      []
    );
  });

  it("gives the caller a line that names each site and says to tell the user", () => {
    const line = signedInLine(["localtest.me", "mail.test"]);
    expect(line).toMatch(/localtest\.me and mail\.test/);
    expect(line).toMatch(/user's own sign-in/);
    expect(line).toMatch(/Tell the user/);
    expect(signedInLine([])).toBe("");
  });
});
