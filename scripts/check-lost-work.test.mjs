import assert from "node:assert/strict";
import { test } from "node:test";

import { lostTests, testTitles } from "./check-lost-work.mjs";

const cases = (...titles) =>
  titles.map((title) => `  it("${title}", () => {});`).join("\n");

test("lostTests names only the cases a change really loses", () => {
  const rows = [
    {
      name: "a deleted case is lost",
      files: [{ file: "a", before: cases("x", "y"), after: cases("x") }],
      lost: ["y"],
    },
    {
      name: "a reworded case is not",
      files: [{ file: "a", before: cases("x"), after: cases("x, better") }],
      lost: [],
    },
    {
      name: "a case moved to another file is not",
      files: [
        { file: "a", before: cases("x", "y"), after: cases("x") },
        { file: "b", before: "", after: cases("y") },
      ],
      lost: [],
    },
    {
      name: "a deleted file loses all its cases",
      files: [{ file: "a", before: cases("x", "y"), after: "" }],
      lost: ["x", "y"],
    },
    {
      name: "an added case changes nothing",
      files: [{ file: "a", before: cases("x"), after: cases("x", "y") }],
      lost: [],
    },
  ];
  for (const { name, files, lost } of rows)
    assert.deepEqual(
      lostTests(files).map(({ title }) => title),
      lost,
      name
    );
});

test("testTitles reads it, test and their modifiers", () => {
  const source = `
    it("a", () => {});
    test('b', () => {});
    it.skip(\`c\`, () => {});
    it.each([1])("d %s", () => {});
    expect(it).toBe(1);
  `;
  assert.deepEqual(testTitles(source), ["a", "b", "c"]);
});
