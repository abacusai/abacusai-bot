import { describe, expect, it } from "vitest";

import { signedInLine, signedInNote, signedInSites } from "./signed-in-note.js";

describe("the user's own sign-in, from the browser to the user", () => {
  it("reads the sites back from the browser's notes, once each, in order", () => {
    const text = [
      "Opened My trips.",
      signedInNote("localtest.me"),
      "Clicked Bookings.",
      signedInNote("mail.test"),
      signedInNote("localtest.me"),
    ].join("\n");
    expect(signedInSites(text)).toEqual(["localtest.me", "mail.test"]);
    expect(signedInSites("The browser is signed in to nothing here.")).toEqual(
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
