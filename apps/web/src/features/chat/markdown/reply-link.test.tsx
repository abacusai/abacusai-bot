import { contract } from "@abacus-ai/contract/contract";
import {
  previewTarget,
  type LinkPreview,
} from "@abacus-ai/contract/contract/links";
import { implement } from "@orpc/server";
import type { UIMessage } from "@tanstack/ai-client";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderApp } from "#renderer/test-support/app-harness";

import { eligibleLinks, PreviewContent } from "./reply-link";
import { selectedText } from "./selection";

const nodeFs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: "node:fs"): unknown };
  }
).process.getBuiltinModule("node:fs") as {
  readFileSync(path: string, encoding: "utf8"): string;
};
const css = nodeFs.readFileSync(
  `${(import.meta as ImportMeta & { dirname: string }).dirname}/../chat.css`,
  "utf8"
);

const os = implement(contract);
let app: Awaited<ReturnType<typeof renderApp>> | undefined;
const intersections = new Map<Element, () => void>();
afterEach(async () => {
  await app?.cleanup();
  app = undefined;
  vi.unstubAllGlobals();
  intersections.clear();
});
const observer = () =>
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        if (target.matches("a.reply-inline-link"))
          intersections.set(target, () =>
            this.callback(
              [{ isIntersecting: true, target } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver
            )
          );
      }
      disconnect() {}
      unobserve() {}
    }
  );
const preview = (url: string): LinkPreview => ({
  url,
  finalUrl: url,
  siteName: "Example",
  title: "A useful page title",
  description: "A short page description",
  imageDataUri: "data:image/png;base64,iVBORw0KGgo=",
});
const start = async (
  fetch: (args: {
    input: { url: string };
  }) => Promise<LinkPreview | null> = vi.fn(
    async ({ input }: { input: { url: string } }) => preview(input.url)
  )
) => {
  observer();
  app = await renderApp("/__ui?fixture=bot-message-inline-links", {
    procedures: { links: { preview: os.links.preview.handler(fetch) } },
  });
  await waitFor(() => expect(intersections.size).toBe(4));
  return fetch;
};
const near = () =>
  act(async () => {
    intersections.forEach((notify) => notify());
  });

it("fetches only near links, shares a URL request, swaps bare labels and preserves markdown labels", async () => {
  const fetch = await start();
  expect(fetch).not.toHaveBeenCalled();
  const first = [...intersections.keys()][0]!;
  expect(first.textContent).toBe(
    "developer.mozilla.org/en-US/docs/Web/JavaScript"
  );
  await near();
  await waitFor(() => expect(first.textContent).toBe("A useful page title"));
  expect(fetch).toHaveBeenCalledTimes(3);
  const caption = first.querySelector(".reply-link-caption")!;
  const range = document.createRange();
  range.selectNodeContents(caption);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  const copy = vi.fn();
  fireEvent.copy(first, { clipboardData: { setData: copy } });
  expect(copy).toHaveBeenCalledWith(
    "text/plain",
    "https://developer.mozilla.org/en-US/docs/Web/JavaScript"
  );
  fireEvent.keyDown(first, { key: "a", metaKey: true });
  expect(document.getSelection()!.toString()).not.toContain(
    "Compare these references"
  );
  expect(document.getSelection()!.toString()).toContain("reference guide");
  expect([...intersections.keys()].at(-1)?.textContent).toBe("reference guide");
  expect(first.getAttribute("aria-label")).toBe(
    "A useful page title — developer.mozilla.org"
  );
  expect(first.getAttribute("title")).toBe(
    "https://developer.mozilla.org/en-US/docs/Web/JavaScript"
  );
  const fragment = document.createDocumentFragment();
  fragment.append(first.cloneNode(true));
  expect(selectedText(fragment)).toBe(
    "https://developer.mozilla.org/en-US/docs/Web/JavaScript"
  );
  expect(document.querySelector('[data-role="user"] a')).toBeNull();
  expect(document.querySelector("code")?.textContent).toBe(
    "https://example.com/code"
  );
  expect(document.querySelector('[data-slot="link-previews"]')).toBeNull();
});
it("keeps failed metadata as a plain link", async () => {
  await start(vi.fn(async () => null));
  await near();
  await waitFor(() =>
    expect(document.querySelector(".reply-inline-link")).toBeNull()
  );
  expect(document.querySelector('[data-role="assistant"] a')?.textContent).toBe(
    "https://developer.mozilla.org/en-US/docs/Web/JavaScript"
  );
});
it("turns titles, icons and cards off without fetching", async () => {
  observer();
  const fetch = vi.fn(() => null);
  app = await renderApp("/settings/general", {
    procedures: { links: { preview: os.links.preview.handler(fetch) } },
  });
  fireEvent.click(
    await screen.findByRole("switch", { name: "Show link previews in replies" })
  );
  await waitFor(() =>
    expect(app!.db.prefs.rows.get("app")?.showLinkPreviews).toBe(false)
  );
  await act(async () =>
    app!.router.navigate({ href: "/__ui?fixture=bot-message-inline-links" })
  );
  await screen.findByText(/Compare these references/);
  expect(document.querySelector(".reply-inline-link")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it("opens on focus after 250ms, fetches on first focus, and closes on Escape", async () => {
  const fetch = await start();
  const link = [...intersections.keys()][0]!;
  fireEvent.focus(link);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(document.querySelector('[data-slot="hover-card-content"]')).toBeNull();
  await waitFor(() =>
    expect(
      document.querySelector('[data-slot="hover-card-content"]')
    ).not.toBeNull()
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(link, { key: "Escape" });
  await waitFor(() =>
    expect(
      document.querySelector('[data-slot="hover-card-content"][data-open]')
    ).toBeNull()
  );
});
it("shows a single loading line and only one open card", async () => {
  await start(vi.fn(() => new Promise<LinkPreview | null>(() => {})));
  const links = [...intersections.keys()];
  fireEvent.focus(links[0]!);
  await waitFor(() =>
    expect(
      document.querySelector('[data-slot="reply-link-loading"]')
    ).not.toBeNull()
  );
  expect(
    document
      .querySelector('[data-slot="reply-link-loading"]')
      ?.querySelectorAll('[data-slot="skeleton"]')
  ).toHaveLength(1);
  fireEvent.focus(links[1]!);
  await waitFor(() =>
    expect(
      document.querySelectorAll('[data-slot="hover-card-content"][data-open]')
    ).toHaveLength(1)
  );
});

describe("hover content", () => {
  it.each(["image", "description", "title"])(
    "fits %s content without a reserved frame",
    (kind) => {
      const value = preview("https://example.com/");
      if (kind !== "image") delete value.imageDataUri;
      if (kind === "title") value.description = "";
      const { container } = render(<PreviewContent preview={value} />);
      const images = container.querySelectorAll("img");
      expect(images).toHaveLength(kind === "image" ? 1 : 0);
      expect(container.innerHTML).not.toMatch(/min-h-|h-28|height:/);
      expect(container.textContent).toContain("A useful page title");
      if (kind === "image") {
        fireEvent.error(images[0]!);
        expect(container.querySelector("img")).toBeNull();
      }
    }
  );
});
it("considers five distinct links in only the latest fifteen assistant messages", () => {
  const message = (
    id: string,
    role: UIMessage["role"] = "assistant"
  ): UIMessage => ({
    id,
    role,
    parts: [
      {
        type: "text",
        content:
          "https://example.com/a https://example.com/a https://example.com/b https://example.com/c https://example.com/d https://example.com/e https://example.com/f `https://example.com/code`",
      },
    ],
  });
  const list = Array.from({ length: 16 }, (_, n) => message(String(n)));
  expect(eligibleLinks(list[0]!, list)).toEqual([]);
  expect(eligibleLinks(list[1]!, list)).toHaveLength(5);
  expect(eligibleLinks(message("user", "user"), list)).toEqual([]);
  expect(eligibleLinks(list[15]!, list)).not.toContain("https://example.com/f");
});
it.each([
  "http://localhost/",
  "http://127.0.0.1/",
  "http://0x7f000001/",
  "http://[::1]/",
  "https://example.com/login",
  "https://example.com/photo.png",
  "https://example.com/file.pdf",
  "https://example.com/bundle.zip",
  "https://raw.githubusercontent.com/org/file",
  "file:///tmp/file",
  "https://user:pass@example.com/",
])("leaves %s plain", (url) => expect(previewTarget(url)).toBe(false));
it("truncates against both character width and the available pane", () => {
  expect(css).toContain("max-width: min(36ch, 100%)");
  expect(css).toContain("text-overflow: ellipsis");
  expect(css).toContain("text-decoration: underline dotted");
});

it("does not open or fetch on touch", async () => {
  const fetch = await start();
  const link = [...intersections.keys()][0]!;
  fireEvent.touchStart(link);
  fireEvent.touchEnd(link);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(fetch).not.toHaveBeenCalled();
  expect(document.querySelector('[data-slot="hover-card-content"]')).toBeNull();
});
