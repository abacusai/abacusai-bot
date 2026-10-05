import * as v from "valibot";
import { expect, it } from "vitest";

import {
  ShellSearch,
  SessionSearch,
  DiffSearch,
} from "#renderer/lib/navigation/search";
it.each([
  "changes",
  "files",
  "agents",
  "device",
  "chat",
  "terminal:one",
  "browser:one",
  "preview:one",
])("R4-T1 parent search preserves session tab %s", (tab) => {
  expect(v.parse(ShellSearch, { tab }).tab).toBe(tab);
  expect(v.parse(SessionSearch, v.parse(ShellSearch, { tab })).tab).toBe(tab);
});
it("R4-T1 scopes a diff without losing its background tab", () => {
  expect(
    v.parse(DiffSearch, {
      tab: "changes",
      path: "src/file.ts",
      scope: "staged",
    })
  ).toMatchObject({
    tab: "changes",
    path: "src/file.ts",
    scope: "staged",
    source: "git",
  });
  expect(
    v.parse(SessionSearch, { tab: "terminal:../bad" }).tab
  ).toBeUndefined();
  expect(v.parse(SessionSearch, {}).tab).toBeUndefined();
});
