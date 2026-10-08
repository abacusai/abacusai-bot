import { contract } from "@abacus-ai/contract/contract";
import type { LinkPreview } from "@abacus-ai/contract/contract/links";
import { implement } from "@orpc/server";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
afterEach(async () => {
  await app?.cleanup();
  app = undefined;
  vi.unstubAllGlobals();
  localStorage.clear();
});
const preview = (url: string): LinkPreview => ({
  url,
  finalUrl: url,
  siteName: "Example",
  title: "Preview title",
  description: "Short description",
  imageDataUri: "data:image/png;base64,iVBORw0KGgo=",
});
let intersect: (() => void) | undefined;
const observer = () =>
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        if (target.getAttribute("data-slot") === "link-previews")
          intersect = () =>
            this.callback(
              [{ isIntersecting: true, target } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver
            );
      }
      disconnect() {}
      unobserve() {}
    }
  );
it("fetches only near-visible replies, renders two cards, and remembers dismissal", async () => {
  observer();
  const fetch = vi.fn(async ({ input }: { input: { url: string } }) =>
    preview(input.url)
  );
  app = await renderApp("/__ui?fixture=bot-message-links", {
    procedures: { links: { preview: os.links.preview.handler(fetch) } },
  });
  await waitFor(() =>
    expect(
      document.querySelectorAll('[data-slot="link-preview-loading"]')
    ).toHaveLength(2)
  );
  expect(fetch).not.toHaveBeenCalled();
  await act(async () => intersect?.());
  await waitFor(() =>
    expect(
      document.querySelectorAll('[data-slot="link-preview"]')
    ).toHaveLength(2)
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  fireEvent.click(
    screen.getAllByRole("button", { name: /Dismiss preview/ })[0]!
  );
  expect(document.querySelectorAll('[data-slot="link-preview"]')).toHaveLength(
    1
  );
  expect(localStorage.getItem("reply-preview-dismissals-v1")).toContain(
    "a-links"
  );
});
it("renders no error UI when the preview fails", async () => {
  observer();
  app = await renderApp("/__ui?fixture=bot-message-links", {
    procedures: { links: { preview: os.links.preview.handler(() => null) } },
  });
  await waitFor(() => expect(intersect).toBeTypeOf("function"));
  await act(async () => intersect?.());
  await waitFor(() =>
    expect(
      document.querySelector('[data-slot="link-preview-loading"]')
    ).toBeNull()
  );
  expect(document.querySelector('[data-slot="link-preview"]')).toBeNull();
});
it("persists the General setting and prevents preview fetching while off", async () => {
  observer();
  const fetch = vi.fn(() => null);
  app = await renderApp("/settings/general", {
    procedures: { links: { preview: os.links.preview.handler(fetch) } },
  });
  const toggle = await screen.findByRole("switch", {
    name: "Show link previews in replies",
  });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  await waitFor(() =>
    expect(app!.db.prefs.rows.get("app")?.showLinkPreviews).toBe(false)
  );
  await act(async () =>
    app!.router.navigate({ href: "/__ui?fixture=bot-message-links" })
  );
  await screen.findByText(/Please compare these two references/);
  expect(document.querySelector('[data-slot="link-previews"]')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
