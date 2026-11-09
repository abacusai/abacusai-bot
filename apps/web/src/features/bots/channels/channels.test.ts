import { agreedItems } from "@abacus-ai/contract/channels";
/** The channel screens' helpers: the @-mention being typed, and a channel's title. */
import { describe, expect, it } from "vitest";

import { groupTitle } from "./data";
import { mentionAt, mentionLinks, stampKind } from "./parts";

describe("mentionAt", () => {
  it("finds the @word at the caret", () => {
    expect(mentionAt("hi @Wri", 7)).toEqual({ start: 3, query: "Wri" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("ask @COO Ac", 11)).toEqual({ start: 4, query: "COO Ac" });
  });

  it("is nothing inside an email or with no @", () => {
    expect(mentionAt("mail me@x", 9)).toBeNull();
    expect(mentionAt("hello", 5)).toBeNull();
  });
});

describe("groupTitle", () => {
  const nameOf = (id: string) => ({ a: "Chief", b: "Writer" })[id] ?? null;
  it("is the name, else the members still there", () => {
    expect(groupTitle({ name: " Launch ", memberBotIds: ["a"] }, nameOf)).toBe(
      "Launch"
    );
    expect(
      groupTitle({ name: "", memberBotIds: ["a", "gone", "b"] }, nameOf)
    ).toBe("Chief, Writer");
  });
});

describe("agreedItems", () => {
  it("takes the numbered lines of a summing-up", () => {
    expect(
      agreedItems(
        "Agreed:\n1. **No new units** in Q4\n2) Spend on ops\nStill open: pricing"
      )
    ).toEqual(["No new units in Q4", "Spend on ops"]);
    expect(agreedItems("We agree on Dec 19.")).toEqual(["We agree on Dec 19."]);
  });
});

describe("mentionLinks", () => {
  const members = [
    { id: "w1", name: "Writer" },
    { id: "w2", name: "Writer Two" },
  ];
  it("turns a member's @mention into a link to that bot, longest name first", () => {
    expect(mentionLinks("ask @Writer and @writer two", members)).toBe(
      "ask [@Writer](#bot-w1) and [@Writer Two](#bot-w2)"
    );
  });
  it("leaves code, emails and unknown names alone", () => {
    expect(mentionLinks("mail me@Writer `@Writer` @Nobody", members)).toBe(
      "mail me@Writer `@Writer` @Nobody"
    );
    expect(mentionLinks("@Writers", members)).toBe("@Writers");
  });
});

describe("stampKind", () => {
  const noon = new Date(2026, 10, 5, 12, 0).getTime();
  it("stamps the first message of a day, then quiet gaps", () => {
    expect(stampKind(null, noon)).toBe("day");
    expect(stampKind(noon - 24 * 60 * 60 * 1000, noon)).toBe("day");
    expect(stampKind(noon - 16 * 60 * 1000, noon)).toBe("gap");
    expect(stampKind(noon - 2 * 60 * 1000, noon)).toBeNull();
  });
});
