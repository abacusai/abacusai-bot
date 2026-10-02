import { beforeEach, expect, it, vi } from "vitest";

import { readDiff } from "./diff-source";
import { keepChange, isReviewed, reviewStore } from "./review-store";
beforeEach(() => reviewStore.setState(() => ({})));
it("R4-T20 review marks distinguish scope and invalidate on content fingerprint", () => {
  keepChange("s", "a.ts", "staged", "hash1");
  expect(isReviewed("s", "a.ts", "staged", "hash1")).toBe(true);
  expect(isReviewed("s", "a.ts", "unstaged", "hash1")).toBe(false);
  expect(isReviewed("s", "a.ts", "staged", "hash2")).toBe(false);
});
it("R4-T25 reads whole contents only for an untracked diff", async () => {
  const diff = vi.fn(async () => ({ kind: "none" }));
  const readText = vi.fn(async () => ({ content: "new contents" }));
  const client = { git: { diff }, files: { readText } };
  const checkout = { workspaceId: "w", sessionId: "s" };
  expect(
    await readDiff(client as never, checkout, "a.ts", "staged", "/repo")
  ).toEqual({ kind: "none" });
  expect(readText).not.toHaveBeenCalled();
  diff.mockResolvedValueOnce({ kind: "untracked" });
  expect(
    await readDiff(client as never, checkout, "a.ts", "unstaged", "/repo")
  ).toMatchObject({ kind: "patch" });
  expect(readText).toHaveBeenCalledWith({
    filePath: "/repo/a.ts",
    hostRoot: "/repo",
    maxBytes: 1000000,
  });
  expect(diff).toHaveBeenCalledWith({
    checkout,
    filePath: "a.ts",
    scope: "staged",
  });
});
it("R4-T11 rejects traversal before a checkout call", async () => {
  const diff = vi.fn();
  await expect(
    readDiff(
      { git: { diff } } as never,
      { workspaceId: "w", sessionId: "s" },
      "../primary.ts",
      "unstaged",
      "/tree"
    )
  ).rejects.toThrow();
  expect(diff).not.toHaveBeenCalled();
});
