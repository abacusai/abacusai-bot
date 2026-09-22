/**
 * The browser settings page's "which browser" section: the built-in view by
 * default, the user's Chrome on request, with the install / connect /
 * disconnect controls that state calls for.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { McpBrowserStatus } from "#shared/contracts";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values == null ? key : `${key} ${JSON.stringify(values)}`,
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { BrowserSettingsPanel } = await import("./browser-settings-dialog");

let status: McpBrowserStatus;
const setBrowserEngine = vi.fn(async (engine: "builtin" | "chrome") => ({
  ...status,
  engine,
}));
const connectChromeBrowser = vi.fn(async () => ({
  ...status,
  chrome: { ...status.chrome, connected: true, tabs: 1 },
}));
const disconnectChromeBrowser = vi.fn(async () => ({
  ...status,
  chrome: { ...status.chrome, connected: false, tabs: 0 },
}));
const setChromeExtensionToken = vi.fn(async () => status);
const openExternal = vi.fn();

const byId = (id: string) =>
  document.querySelector<HTMLElement>(`[data-id="${id}"]`);

const renderPanel = () =>
  render(
    (
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <BrowserSettingsPanel />
      </QueryClientProvider>
    ) as JSX.Element
  );

beforeEach(() => {
  status = {
    running: true,
    port: 1,
    enabled: true,
    approval: "always",
    engine: "builtin",
    chrome: {
      browser: "Google Chrome",
      extensionInstalled: false,
      installUrl: "https://chromewebstore.google.com/detail/x",
      connecting: false,
      connected: false,
      tabs: 0,
      error: null,
    },
  };
  setBrowserEngine.mockClear();
  connectChromeBrowser.mockClear();
  disconnectChromeBrowser.mockClear();
  openExternal.mockClear();
  Object.assign(window, {
    api: {
      openExternal,
      agent: {
        getMcpBrowserStatus: async () => status,
        setMcpBrowserEnabled: vi.fn(),
        setBrowserApproval: vi.fn(),
        clearBrowserData: vi.fn(),
        setBrowserEngine,
        connectChromeBrowser,
        disconnectChromeBrowser,
        setChromeExtensionToken,
        onEvent: () => () => {},
      },
    },
  });
});

afterEach(cleanup);

describe("the browser engine section", () => {
  it("shows the built-in browser chosen and no Chrome controls", async () => {
    renderPanel();
    await waitFor(() => expect(byId("browser-settings-engine")).not.toBeNull());
    expect(byId("browser-settings-engine")?.textContent).toContain(
      "browserSettings.engine.builtin"
    );
    expect(byId("browser-settings-chrome")).toBeNull();
  });

  it("offers the extension install when Chrome is chosen but the extension is missing", async () => {
    status.engine = "chrome";
    renderPanel();

    await waitFor(() => expect(byId("browser-settings-chrome")).not.toBeNull());
    expect(byId("browser-settings-chrome")?.textContent).toContain(
      "browserSettings.chrome.extensionMissing"
    );
    fireEvent.click(byId("browser-settings-chrome-install")!);
    expect(openExternal).toHaveBeenCalledWith(
      "https://chromewebstore.google.com/detail/x"
    );
    expect(byId("browser-settings-chrome-connect")).toBeNull();
  });

  it("connects when the extension is there, and shows the tab count once connected", async () => {
    status.engine = "chrome";
    status.chrome.extensionInstalled = true;
    renderPanel();

    await waitFor(() =>
      expect(byId("browser-settings-chrome-connect")).not.toBeNull()
    );
    expect(byId("browser-settings-chrome")?.textContent).toContain(
      "browserSettings.chrome.ready"
    );
    fireEvent.click(byId("browser-settings-chrome-connect")!);

    await waitFor(() => expect(connectChromeBrowser).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(byId("browser-settings-chrome-disconnect")).not.toBeNull()
    );
    expect(byId("browser-settings-chrome")?.textContent).toContain('"count":1');

    fireEvent.click(byId("browser-settings-chrome-disconnect")!);
    await waitFor(() =>
      expect(disconnectChromeBrowser).toHaveBeenCalledTimes(1)
    );
  });

  it("shows why the last connection failed", async () => {
    status.engine = "chrome";
    status.chrome.extensionInstalled = true;
    status.chrome.error = "the browser did not connect in time";
    renderPanel();

    await waitFor(() =>
      expect(byId("browser-settings-chrome-error")?.textContent).toBe(
        "the browser did not connect in time"
      )
    );
  });

  it("saves a pasted extension token", async () => {
    status.engine = "chrome";
    status.chrome.extensionInstalled = true;
    renderPanel();
    await waitFor(() =>
      expect(byId("browser-settings-chrome-token")).not.toBeNull()
    );

    expect(
      (byId("browser-settings-chrome-token-save") as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.change(byId("browser-settings-chrome-token")!, {
      target: { value: " abc123 " },
    });
    fireEvent.click(byId("browser-settings-chrome-token-save")!);

    await waitFor(() =>
      expect(setChromeExtensionToken).toHaveBeenCalledWith(" abc123 ")
    );
  });
});
