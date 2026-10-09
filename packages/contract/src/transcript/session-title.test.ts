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
  ).toBe("Review @src/main.ts and `npm test`");
  expect(generateSessionTitle("\n\t ")).toBe("");
});

it("keeps historical 60-character titles and clips longer ones to 57 plus ellipsis", () => {
  expect(generateSessionTitle("x".repeat(60))).toBe("x".repeat(60));
  expect(generateSessionTitle("x".repeat(61))).toBe(`${"x".repeat(57)}…`);
  expect(generateSessionTitle(`${"x".repeat(56)} more words`)).toBe(
    `${"x".repeat(56)}…`
  );
});
