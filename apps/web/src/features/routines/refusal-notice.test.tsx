import { render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";

import { initI18n } from "#renderer/lib/i18n";
beforeAll(() => initI18n());

import { RoutineRefusalNotice } from "./refusal-notice";
vi.mock("#renderer/lib/use-app-context", () => ({
  useAppContext: () => ({ transport: { client: {} } }),
}));
it("keeps desktop plan refusals about hosted routines", () => {
  render(
    <RoutineRefusalNotice
      refusal={{
        key: "routines.hosted.planRequired",
        upgrade: true,
        upgradeUrl: null,
        field: null,
      }}
    />
  );
  expect(screen.getByRole("button", { name: "Upgrade" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Download desktop" })).toBeNull();
  expect(screen.queryByText("Use AbacusAI Bot on your computer.")).toBeNull();
});
