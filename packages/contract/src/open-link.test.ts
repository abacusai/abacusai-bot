import { describe, expect, it } from "vitest";

import {
  OPEN_LINK_DRAFT_MAX,
  openLinkInArgv,
  parseOpenLink,
} from "./open-link";

describe("parseOpenLink", () => {
  it.each<[string, ReturnType<typeof parseOpenLink>]>([
    [
      "abacusaibot://open?session=abc-123&draft=Add%20my%20menu&src=email_d1",
      { sessionId: "abc-123", draft: "Add my menu", src: "email_d1" },
    ],
    ["abacusaibot://open", { sessionId: null, draft: null, src: "" }],
    // Windows adds a slash before the query.
    [
      "abacusaibot://open/?session=s1",
      { sessionId: "s1", draft: null, src: "" },
    ],
    [
      "ABACUSAIBOT://OPEN?session=s1",
      { sessionId: "s1", draft: null, src: "" },
    ],
    // An id the thread store would refuse opens home, and its draft goes with it.
    [
      "abacusaibot://open?session=..%2Fetc&draft=hi",
      { sessionId: null, draft: null, src: "" },
    ],
    [
      "abacusaibot://open?session=.hidden",
      { sessionId: null, draft: null, src: "" },
    ],
    [
      `abacusaibot://open?session=${"a".repeat(129)}`,
      { sessionId: null, draft: null, src: "" },
    ],
    // Control, bidi and zero-width characters never reach the composer.
    [
      "abacusaibot://open?session=s&draft=%20one%0Atwo%E2%80%AEthree%E2%80%8B%00%20",
      { sessionId: "s", draft: "one two three", src: "" },
    ],
    [
      "abacusaibot://open?session=s&draft=%0A%09",
      { sessionId: "s", draft: null, src: "" },
    ],
    [
      "abacusaibot://open?src=Email-Day3%3Cscript%3E_" + "x".repeat(60),
      {
        sessionId: null,
        draft: null,
        src: `emailday3script_${"x".repeat(24)}`,
      },
    ],
    // The first of a repeated parameter.
    [
      "abacusaibot://open?session=a&session=b",
      { sessionId: "a", draft: null, src: "" },
    ],
  ])("reads %s", (raw, link) => {
    expect(parseOpenLink(raw)).toEqual(link);
  });

  it.each([
    "https://open?session=s",
    "abacusaibot://send?session=s&draft=x",
    "abacusaibot://open/approve?session=s",
    "abacusaibot:open?session=s",
    "not a url",
    `abacusaibot://open?draft=${"x".repeat(5000)}`,
    42,
    null,
  ])("ignores %s", (raw) => {
    expect(parseOpenLink(raw)).toBeNull();
  });

  it("cuts a long draft at a code point", () => {
    const draft = `${"a".repeat(OPEN_LINK_DRAFT_MAX - 1)}😀😀`;
    const link = parseOpenLink(
      `abacusaibot://open?session=s&draft=${encodeURIComponent(draft)}`
    );
    expect(Array.from(link!.draft!)).toHaveLength(OPEN_LINK_DRAFT_MAX);
    expect(link!.draft!.endsWith("😀")).toBe(true);
  });
});

it("finds the link among Chromium's own arguments", () => {
  expect(
    openLinkInArgv([
      "/opt/AbacusAI-Bot/abacusai-bot",
      "--allow-file-access-from-files",
      "abacusaibot://open?session=s",
    ])
  ).toBe("abacusaibot://open?session=s");
  expect(openLinkInArgv(["app", "--flag", "https://x"])).toBeNull();
});
