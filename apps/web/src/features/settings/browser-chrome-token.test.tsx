import { contract } from "@abacus-ai/contract/contract";
/**
 * Settings → Browser, the Chrome extension token: a saved token can be
 * removed again, the toast says what happened, and connecting with a saved
 * token does not tell the user to allow it in their browser.
 */
import type { McpBrowserStatus } from "@abacus-ai/contract/contracts";
import { implement } from "@orpc/server";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterContextProvider } from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import enUS from "#locales/en-US.json";
import { DbProvider } from "#renderer/data/db";
import { createHarness } from "#renderer/test-support/app-harness";

import { BrowserPage } from "./environment";

const toasts = vi.hoisted(() => [] as string[]);
vi.mock("#renderer/lib/platform", async (original) => ({
  ...(await original<typeof import("#renderer/lib/platform")>()),
  IS_ELECTRON: true,
}));
vi.mock("#renderer/lib/toast", async (original) => ({
  ...(await original<typeof import("#renderer/lib/toast")>()),
  showInfo: (message: string) => {
    toasts.push(message);
  },
}));

const chrome = enUS.browserSettings.chrome;

const statusWith = (
  chromeStatus: Partial<McpBrowserStatus["chrome"]>
): McpBrowserStatus => ({
  running: true,
  port: 1,
  enabled: true,
  approval: "always",
  engine: "chrome",
  chrome: {
    browser: "Google Chrome",
    extensionInstalled: true,
    installUrl: "https://example.test/install",
    connecting: false,
    connected: false,
    tabs: 0,
    tokenSet: false,
    error: null,
    ...chromeStatus,
  },
});

let cleanup = async () => {};
afterEach(async () => {
  await cleanup();
  toasts.length = 0;
});

/** The page over a host that saves the token the way the app does: an empty one removes it. */
const renderPage = async (initial: McpBrowserStatus) => {
  let status = initial;
  const saved: string[] = [];
  const os = implement(contract);
  const harness = await createHarness("/", {
    procedures: {
      browser: {
        status: os.browser.status.handler(() => status),
        chrome: {
          setExtensionToken: os.browser.chrome.setExtensionToken.handler(
            ({ input }) => {
              saved.push(input.token);
              const value = input.token.split("=").pop()!.trim();
              status = statusWith({
                ...status.chrome,
                tokenSet: value.length > 0,
              });
              return status;
            }
          ),
        },
      },
    },
  });
  const view = (
    <QueryClientProvider client={harness.router.options.context.queryClient}>
      <RouterContextProvider router={harness.router}>
        <DbProvider value={harness.appDb}>
          <BrowserPage />
        </DbProvider>
      </RouterContextProvider>
    </QueryClientProvider>
  );
  let rendered!: ReturnType<typeof render>;
  await act(async () => {
    rendered = render(view);
  });
  cleanup = async () => {
    rendered.unmount();
    await harness.cleanup();
  };
  return { saved };
};

/** The token input's row: its Save and Remove buttons (the page has another Save). */
const tokenRow = async () => {
  const input = await screen.findByLabelText(enUS.phase5.extensionToken);
  return { input, row: within(input.parentElement!) };
};

it("a saved token can be removed, and the toast says it was removed", async () => {
  const { saved } = await renderPage(statusWith({ tokenSet: true }));
  const { row } = await tokenRow();
  fireEvent.click(row.getByRole("button", { name: chrome.tokenRemove }));
  await waitFor(() => expect(saved).toEqual([""]));
  await waitFor(() => expect(toasts).toEqual([chrome.tokenRemoved]));
  // Nothing saved now: nothing to remove.
  await waitFor(() =>
    expect(row.queryByRole("button", { name: chrome.tokenRemove })).toBeNull()
  );
});

it("a pasted line with no token in it removes the token, and says so", async () => {
  const { saved } = await renderPage(statusWith({ tokenSet: true }));
  const { input, row } = await tokenRow();
  fireEvent.change(input, {
    target: { value: "PLAYWRIGHT_MCP_EXTENSION_TOKEN=" },
  });
  fireEvent.click(row.getByRole("button", { name: enUS.phase5.save }));
  await waitFor(() =>
    expect(saved).toEqual(["PLAYWRIGHT_MCP_EXTENSION_TOKEN="])
  );
  await waitFor(() => expect(toasts).toEqual([chrome.tokenRemoved]));
});

it("saving a token says it was saved", async () => {
  const { saved } = await renderPage(statusWith({ tokenSet: false }));
  const { input, row } = await tokenRow();
  expect(row.queryAllByRole("button").map((b) => b.textContent)).toEqual([
    enUS.phase5.save,
  ]);
  fireEvent.change(input, {
    target: { value: "PLAYWRIGHT_MCP_EXTENSION_TOKEN=abc" },
  });
  fireEvent.click(row.getByRole("button", { name: enUS.phase5.save }));
  await waitFor(() =>
    expect(saved).toEqual(["PLAYWRIGHT_MCP_EXTENSION_TOKEN=abc"])
  );
  await waitFor(() => expect(toasts).toEqual([chrome.tokenSaved]));
});

it("connecting with a saved token does not ask the user to allow it", async () => {
  await renderPage(statusWith({ tokenSet: true, connecting: true }));
  expect(
    await screen.findByText(
      chrome.connectingWithToken.replace("{{browser}}", "Google Chrome")
    )
  ).toBeTruthy();
  expect(screen.queryByText(chrome.connecting)).toBeNull();
});

it("connecting without a token asks the user to allow it in their browser", async () => {
  await renderPage(statusWith({ tokenSet: false, connecting: true }));
  expect(await screen.findByText(chrome.connecting)).toBeTruthy();
});
