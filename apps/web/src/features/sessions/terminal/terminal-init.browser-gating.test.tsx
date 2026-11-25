import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import { render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { i18n } from "#renderer/lib/i18n";
const mocks = vi.hoisted(() => ({ get: vi.fn(), load: vi.fn() }));
vi.mock("ghostty-web", () => ({
  Ghostty: { load: mocks.load },
  Terminal: class {},
  FitAddon: class {},
}));
vi.mock("../data/queries", () => ({
  useSessionsTransport: () => ({ client: {} }),
}));
vi.mock("./terminal-registry", () => ({ getTerminalView: mocks.get }));
import { ghosttyReady } from "#renderer/components/terminal/ghostty";

import { TerminalTab } from "./terminal-tab";

// The page's words come from the app's copy: load it, without the React
// binding, so this test's keys still read as keys.
beforeAll(() =>
  i18n.init({ resources: { "en-US": { translation: enUS } }, lng: "en-US" })
);
it("loads the served Vite WASM asset explicitly and allows retry after failure", async () => {
  mocks.load
    .mockRejectedValueOnce(new Error("WASM unavailable"))
    .mockResolvedValue({});
  await expect(ghosttyReady()).rejects.toThrow("WASM unavailable");
  await ghosttyReady();
  const url = mocks.load.mock.calls[0]![0] as string;
  expect(url).toContain("ghostty-vt.wasm");
  expect(url.startsWith("data:")).toBe(false);
  expect(url).not.toBe("/ghostty-vt.wasm");
  expect(mocks.load).toHaveBeenCalledTimes(2);
});
it("shows initialization failure for hidden terminal tabs without an unhandled rejection", async () => {
  mocks.get.mockRejectedValue(new Error("WASM unavailable"));
  const view = render(
    <TerminalTab
      row={{ workspaceId: "w", id: "s" } as SessionRow}
      id="t"
      visible={false}
      onClose={() => {}}
      dispatch={() => {}}
      onUrl={() => {}}
    />
  );
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Something went wrong. Try again."
  );
  view.unmount();
});
