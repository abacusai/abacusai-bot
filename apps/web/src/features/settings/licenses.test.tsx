import { contract } from "@abacus-ai/contract/contract";
import { implement } from "@orpc/server";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import en from "#locales/en-US.json";
import { ABACUS_HELP_URL } from "#renderer/lib/abacus-links";
import { renderApp } from "#renderer/test-support/app-harness";
const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard"
);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  app?.view.unmount();
  await app?.cleanup();
  app = undefined;
  vi.unstubAllGlobals();
  if (originalClipboard)
    Object.defineProperty(navigator, "clipboard", originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});
it("About loads licenses only on request, searches grouped packages and exposes full text and notices", async () => {
  const fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      packages: [
        {
          name: "react",
          version: "19.3.0",
          license: "MIT",
          textHash: "mit",
          url: "https://github.com/facebook/react",
        },
        { name: "other", version: "1", license: "ISC", textHash: "isc" },
      ],
      texts: {
        mit: "Copyright Meta. Permission is hereby granted.",
        isc: "ISC license text",
      },
    }),
  }));
  vi.stubGlobal("fetch", fetch);
  const copy = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: copy },
  });
  const open = vi.fn(async (_input: { url: string }) => undefined);
  const os = implement(contract);
  app = await renderApp("/settings/about", {
    procedures: {
      system: {
        openExternal: os.system.openExternal.handler(({ input }) =>
          open(input)
        ),
      },
    },
  });
  await screen.findByRole("heading", { name: "About" });
  const help = screen.getByRole("link", { name: en.profile.help });
  expect(help.getAttribute("href")).toBe(ABACUS_HELP_URL);
  expect(help.getAttribute("rel")).toBe("noopener noreferrer");
  fireEvent.click(help);
  await waitFor(() =>
    expect(open).toHaveBeenCalledWith({ url: ABACUS_HELP_URL })
  );
  open.mockClear();
  expect(screen.queryByText("Open the Library")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  const section = within(
    document.querySelector<HTMLElement>(
      '[data-setting-id="openSourceLicenses"]'
    )!
  );
  fireEvent.click(section.getByRole("button", { name: "Open" }));
  await screen.findByText("react");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("link", { name: "Download notices" }).getAttribute("href")
  ).toContain("THIRD_PARTY_NOTICES.txt");
  expect(
    screen.getByRole("link", { name: "Chromium and Node.js notices" })
  ).not.toBeNull();
  fireEvent.change(
    screen.getByRole("textbox", { name: "Search packages or licenses" }),
    { target: { value: "react" } }
  );
  await waitFor(() => expect(screen.queryByText("other")).toBeNull());
  const summary = screen.getByText("react").closest("summary")!;
  fireEvent.click(summary);
  expect(screen.getByLabelText("License text for react").textContent).toContain(
    "Copyright Meta"
  );
  expect(
    screen.getByRole("button", { name: "Open repository for react" })
  ).not.toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Copy repository link for react" })
  );
  await waitFor(() =>
    expect(copy).toHaveBeenCalledWith("https://github.com/facebook/react")
  );
  await screen.findByText("Copied");
  fireEvent.click(
    screen.getByRole("button", { name: "Open repository for react" })
  );
  await waitFor(() =>
    expect(open).toHaveBeenCalledWith({
      url: "https://github.com/facebook/react",
    })
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Search packages or licenses" }),
    { target: { value: "no-match" } }
  );
  await screen.findByText("No matching packages.");
});
it("About reports an asset failure with a retry action", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false }))
  );
  app = await renderApp("/settings/about");
  await screen.findByRole("heading", { name: "About" });
  const row = within(
    document.querySelector<HTMLElement>(
      '[data-setting-id="openSourceLicenses"]'
    )!
  );
  fireEvent.click(row.getByRole("button", { name: "Open" }));
  expect(await screen.findByRole("alert")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
});
