import { Store } from "@tanstack/react-store";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";

import { initI18n } from "#renderer/lib/i18n";

import { BrowserTab } from "./browser-tab.browser";

const fixture = vi.hoisted(() => ({
  tier: "free" as string | undefined,
  client: { files: {} },
  upgrade: vi.fn(async () => {}),
  openExternal: vi.fn(async () => {}),
}));
vi.mock("#renderer/lib/use-account", () => ({
  useAccount: () => ({
    data:
      fixture.tier == null ? undefined : { subscription_tier: fixture.tier },
  }),
}));
vi.mock("#renderer/lib/upgrade", () => ({ openUpgrade: fixture.upgrade }));
vi.mock("#renderer/lib/platform-system", () => ({
  platformSystem: () => ({ openExternal: fixture.openExternal }),
}));
beforeEach(() => {
  fixture.tier = "free";
  vi.clearAllMocks();
});

vi.mock("#renderer/features/sessions/data/queries", () => ({
  useSessionsTransport: () => ({ client: fixture.client }),
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
  expect(screen.getByRole("heading").textContent).toContain("Preview your app");
  expect(
    screen.getByRole("button", { name: "Download" }).getAttribute("href")
  ).toBe("https://bot.abacus.ai");
  expect(screen.queryByRole("button", { name: "Open browser" })).toBeNull();
  expect(screen.getByText(/VM-local links cannot open/)).toBeTruthy();
});

it("keeps public links available alongside desktop download", () => {
  render(<BrowserTab {...props} url="https://example.com/preview" />);
  const link = screen.getByRole("link", { name: "Open browser" });
  expect(link.getAttribute("href")).toBe("https://example.com/preview");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
});

it("keeps HTML file previews in the web app", () => {
  render(<BrowserTab {...props} file="index.html" />);
  expect(screen.getByTestId("file-preview").textContent).toBe("index.html");
  expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
});

it("offers free accounts Upgrade and Download", () => {
  render(<BrowserTab {...props} url="http://localhost:3000" />);
  expect(screen.getAllByRole("button")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));
  expect(fixture.upgrade).toHaveBeenCalledWith(fixture.client);
  expect(
    screen.queryByRole("button", { name: "Open AbacusAI Agent" })
  ).toBeNull();
});

it.each(["pro", "basic"])(
  "offers %s accounts the same Agent link as the rail plus Download",
  (tier) => {
    fixture.tier = tier;
    render(<BrowserTab {...props} url="http://localhost:3000" />);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    const agent = screen.getByRole("button", { name: "Open AbacusAI Agent" });
    expect(agent.getAttribute("href")).toBe("https://apps.abacus.ai/chatllm");
    fireEvent.click(agent);
    expect(fixture.openExternal).toHaveBeenCalledWith({
      url: "https://apps.abacus.ai/chatllm",
    });
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
  }
);

it.each([undefined, "future-plan"])(
  "does not classify an unknown account %s as free or paid",
  (tier) => {
    fixture.tier = tier;
    render(<BrowserTab {...props} url="http://localhost:3000" />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Open AbacusAI Agent" })
    ).toBeNull();
  }
);
