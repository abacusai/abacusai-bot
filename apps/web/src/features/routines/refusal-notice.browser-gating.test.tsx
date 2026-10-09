import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";

import { initI18n } from "#renderer/lib/i18n";
beforeAll(() => initI18n());

import { DESKTOP_DOWNLOAD_URL } from "#renderer/lib/abacus-links";
import { openUpgrade } from "#renderer/lib/upgrade";

import { RoutineRefusalNotice } from "./refusal-notice";
vi.mock("#renderer/lib/use-app-context", () => ({
  useAppContext: () => ({ transport: { client: {} } }),
}));
vi.mock("#renderer/lib/upgrade", () => ({
  openUpgrade: vi.fn(async () => {}),
}));
const refusal = {
  key: "routines.hosted.planRequired",
  upgrade: true,
  upgradeUrl: null,
  field: null,
};
it("offers local desktop routines alongside a hosted-plan upgrade", () => {
  render(<RoutineRefusalNotice refusal={refusal} />);
  expect(
    screen.getByText(
      "Or run local routines on your computer with the desktop app."
    )
  ).toBeTruthy();
  const download = screen.getByRole("button", { name: "Download desktop" });
  expect(download.getAttribute("href")).toBe(DESKTOP_DOWNLOAD_URL);
  fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
  expect(openUpgrade).toHaveBeenCalledOnce();
});
it("preserves the server's upgrade link", () => {
  render(
    <RoutineRefusalNotice
      refusal={{ ...refusal, upgradeUrl: "https://agent.abacus.ai/plan" }}
    />
  );
  expect(
    screen.getByRole("button", { name: "Upgrade" }).getAttribute("href")
  ).toBe("https://agent.abacus.ai/plan");
});
it("does not upsell validation and operational failures", () => {
  render(
    <RoutineRefusalNotice
      refusal={{ ...refusal, key: "routines.refused.busy", upgrade: false }}
    />
  );
  expect(screen.queryByRole("button", { name: "Download desktop" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
});
