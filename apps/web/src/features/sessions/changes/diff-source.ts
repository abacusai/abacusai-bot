import { createPatch } from "diff";

import type { AppClient } from "#renderer/data/transport/types";
import type { CheckoutRef, GitDiffResult } from "#shared/contract/checkout";

import { isRelativePath } from "../data/search";
export const readDiff = async (
  client: AppClient,
  checkout: CheckoutRef,
  path: string,
  scope: "staged" | "unstaged",
  root: string
): Promise<GitDiffResult> => {
  if (!isRelativePath(path))
    throw new Error("Expected a checkout-relative path");
  const result = await client.git.diff({ checkout, filePath: path, scope });
  if (result.kind !== "untracked") return result;
  const text = await client.files.readText({
    filePath: `${root}/${path}`,
    hostRoot: root,
    maxBytes: 1000000,
  });
  return { kind: "patch", patch: createPatch(path, "", text.content) };
};
