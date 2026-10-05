import { expect, it, vi } from "vitest";

vi.mock("../../../renderer/data/db/index", () => ({}));

import { PREFS_DEFAULTS } from "./prefs-store";

it("the renderer's loading defaults equal every main preference leaf", async () => {
  // Keep the two TS composite projects separate while comparing their values.
  const rendererModule = "../../../renderer/data/db/prefs";
  const { DEFAULT_PREFS } = await import(rendererModule);
  expect(DEFAULT_PREFS).toEqual({
    id: "app",
    ...PREFS_DEFAULTS,
    updatedAt: new Date(0).toISOString(),
  });
});
