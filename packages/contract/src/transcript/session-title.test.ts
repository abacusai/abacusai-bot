import { expect, it } from "vitest";

import { generateSessionTitle } from "./session-title";

it("uses the first nonempty line, as the pre-rewrite session composer did", () => {
  expect(
    generateSessionTitle("\n  Fix the deployment  \nInclude the logs")
  ).toBe("Fix the deployment");
  expect(generateSessionTitle("\n\t ")).toBe("");
});

it("keeps historical 60-character titles and clips longer ones to 57 plus ellipsis", () => {
  expect(generateSessionTitle("x".repeat(60))).toBe("x".repeat(60));
  expect(generateSessionTitle("x".repeat(61))).toBe(`${"x".repeat(57)}…`);
  expect(generateSessionTitle(`${"x".repeat(56)} more words`)).toBe(
    `${"x".repeat(56)}…`
  );
});

// What the chat shows for the line, read as CommonMark: only real syntax goes.
it.each([
  [
    "Build a modern app called **TaskFlow Pro** with auth",
    "Build a modern app called TaskFlow Pro with auth",
  ],
  ["## Refactor `src/app.tsx`", "Refactor src/app.tsx"],
  ["Summarise [the report](https://example.com/q3)", "Summarise the report"],
  [
    "> Write a short reply to the landlord",
    "Write a short reply to the landlord",
  ],
  ["Review @src/main.ts and `npm test`", "Review @src/main.ts and npm test"],
  ["Edit `__init__.py`", "Edit __init__.py"],
  ["what is 2**10", "what is 2**10"],
  ["src/**/*.ts", "src/**/*.ts"],
  ["explain *args and **kwargs", "explain *args and **kwargs"],
  ["2 * 3 * 4", "2 * 3 * 4"],
  ["мой_файл_тест", "мой_файл_тест"],
  ["rename my_snake_case_file", "rename my_snake_case_file"],
  ["**Bold that never closes", "**Bold that never closes"],
  ["~~old~~ new plan", "old new plan"],
  ["- [ ] Fix the login bug", "Fix the login bug"],
  ["1. First step", "First step"],
  ["**\nThe next line", "**"],
  ["Open C:\\Users\\me\\notes.md", "Open C:\\Users\\me\\notes.md"],
  ["see <https://example.com/x>", "see https://example.com/x"],
  // Real CommonMark syntax, read as the chat bubble reads it.
  ["# of users per day", "of users per day"],
  ["> 100ms is slow", "100ms is slow"],
  ["fn[0](arg)", "fn0"],
  ["fn[0] is the first", "fn[0] is the first"],
  ["\\# of users per day", "# of users per day"],
])("names %j as %j", (message, title) => {
  expect(generateSessionTitle(message)).toBe(title);
});
