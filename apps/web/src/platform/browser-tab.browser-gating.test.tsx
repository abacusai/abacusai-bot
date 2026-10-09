import { Store } from "@tanstack/react-store";
import { render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";

import { initI18n } from "#renderer/lib/i18n";

import { BrowserTab } from "./browser-tab.browser";

vi.mock("#renderer/features/sessions/data/queries", () => ({
  useSessionsTransport: () => ({ client: { files: {} } }),
}));
vi.mock("#renderer/components/file-preview", () => ({
  FilePreview: ({ path }: { path: string }) => (
    <div data-testid="file-preview">{path}</div>
  ),
}));
beforeAll(initI18n);

const props = {
  id: "browser",
  row: { id: "session", workspaceId: "workspace" },
  visible: true,
  root: "/workspace",
  presenter: {
    captures: new Store<Record<string, string>>({}),
    owner: new Store<string | null>(null),
    refresh: async () => {},
    activate: async () => {},
    register: () => () => {},
  },
  blocked: () => false,
};

it("offers desktop download without opening VM localhost on the user's machine", () => {
  render(<BrowserTab {...props} url="http://localhost:3000" />);
  expect(screen.getByRole("heading").textContent).toContain(
    "AbacusAI Bot desktop"
  );
  expect(
    screen
      .getByRole("button", { name: "Get the desktop app" })
      .getAttribute("href")
  ).toBe("https://bot.abacus.ai");
  expect(screen.queryByRole("button", { name: "Open browser" })).toBeNull();
  expect(screen.getByText(/This address is on your remote VM/)).toBeTruthy();
});

it("keeps public links available alongside desktop download", () => {
  render(<BrowserTab {...props} url="https://example.com/preview" />);
  const link = screen.getByRole("button", { name: "Open browser" });
  expect(link.getAttribute("href")).toBe("https://example.com/preview");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
});

it("keeps HTML file previews in the web app", () => {
  render(<BrowserTab {...props} file="index.html" />);
  expect(screen.getByTestId("file-preview").textContent).toBe("index.html");
  expect(
    screen.queryByRole("button", { name: "Get the desktop app" })
  ).toBeNull();
});
