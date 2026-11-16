import { describe, expect, it } from "vitest";

import {
  SIGNED_IN_BY_RUN_META,
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

describe("a sign-in the run made itself, with details the user gave", () => {
  it("is read from its own _meta key, and its line never calls it the user's own sign-in", () => {
    expect(
      signedInSitesOf(
        { [SIGNED_IN_BY_RUN_META]: ["saucedemo.com"] },
        SIGNED_IN_BY_RUN_META
      )
    ).toEqual(["saucedemo.com"]);
    expect(
      signedInSitesOf({ [SIGNED_IN_BY_RUN_META]: ["saucedemo.com"] })
    ).toEqual([]);
    const line = signedInLine([], ["saucedemo.com"]);
    expect(line).toMatch(
      /signed in to saucedemo\.com itself, with the sign-in details the user gave/
    );
    expect(line).not.toMatch(/user's own sign-in/);
    expect(signedInLine(["mail.test"], ["saucedemo.com"])).toMatch(
      /own sign-in on mail\.test[\s\S]*signed in to saucedemo\.com itself/
    );
  });
});
