import { fileURLToPath } from "node:url";

import { expect, it, vi } from "vitest";

vi.mock("../../../../../web/src/data/db/index", () => ({}));

import { PREFS_DEFAULTS } from "./prefs-store";

it("the renderer's loading defaults equal every main preference leaf", async () => {
  // Keep the two TS composite projects separate while comparing their values.
  const rendererModule = fileURLToPath(
    new URL("../../../../../web/src/data/db/prefs.ts", import.meta.url)
  );
  const { DEFAULT_PREFS } = await import(rendererModule);
  expect(DEFAULT_PREFS).toEqual({
    id: "app",
    ...PREFS_DEFAULTS,
    updatedAt: new Date(0).toISOString(),
  });
});
