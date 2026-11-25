import { expect, it } from "vitest";

import { generateSessionTitle } from "./session-title";

it("uses the first nonempty line, as the pre-rewrite session composer did", () => {
  expect(
    generateSessionTitle("\n  Fix the deployment  \nInclude the logs")
  ).toBe("Fix the deployment");
  expect(
    generateSessionTitle(
      "Review @src/main.ts and `npm test`\nFollow-up details"
    )
  ).toBe("Review @src/main.ts and npm test");
  expect(generateSessionTitle("\n\t ")).toBe("");
});

it("keeps historical 60-character titles and clips longer ones to 57 plus ellipsis", () => {
  expect(generateSessionTitle("x".repeat(60))).toBe("x".repeat(60));
  expect(generateSessionTitle("x".repeat(61))).toBe(`${"x".repeat(57)}…`);
  expect(generateSessionTitle(`${"x".repeat(56)} more words`)).toBe(
    `${"x".repeat(56)}…`
  );
});

it.each([
  [
    "Build a modern app called **TaskFlow Pro** with auth",
    "Build a modern app called TaskFlow Pro with auth",
  ],
  ["## Refactor `src/app.tsx`", "Refactor src/app.tsx"],
  ["> Summarise [the report](https://example.com/q3)", "Summarise the report"],
  ["- [ ] Fix _the_ ~~old~~ *login* bug", "Fix the old login bug"],
  ["**\nRename my_snake_case file 2 * 3", "Rename my_snake_case file 2 * 3"],
  ["Open C:\\Users\\me\\notes.md", "Open C:\\Users\\me\\notes.md"],
  ["**Bold that never closes", "Bold that never closes"],
])("names %j as plain text", (message, title) => {
  expect(generateSessionTitle(message)).toBe(title);
});
