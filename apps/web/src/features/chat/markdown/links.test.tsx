import { fireEvent, render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { initI18n } from "#renderer/lib/i18n";

import { messageLinks } from "./links";
import { Markdown, MarkdownLinksProvider } from "./markdown";
import { selectedText } from "./selection";

beforeAll(initI18n);
describe("reply links", () => {
  it("handles punctuation, balanced parentheses, unicode and existing labels", () => {
    expect(
      messageLinks(
        'https://example.com/a, (https://example.com/b). https://example.com/wiki/A_(B). www.example.com/x! example.com/path "https://example.com/日本語" [label](https://example.com/custom)'
      )
    ).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/wiki/A_(B)",
      "http://www.example.com/x",
      "http://example.com/path",
      "https://example.com/%E6%97%A5%E6%9C%AC%E8%AA%9E",
      "https://example.com/custom",
    ]);
  });
  it("excludes code, image URLs, email, bare ambiguous domains and credentials", () => {
    expect(
      messageLinks(
        "`https://example.com/code`\n\n```\nhttps://example.com/block\n```\n\n![image](https://example.com/image) user@example.com example.com https://user:pass@example.com/"
      )
    ).toEqual([]);
  });
  it("only links normal assistant text and preserves markdown labels", () => {
    const { container, rerender } = render(
      <Markdown
        content="See https://example.com/path and [custom](https://example.org/)"
        role="assistant"
        reply
      />
    );
    expect(container.querySelectorAll("a")).toHaveLength(2);
    expect(container.querySelector("a")?.title).toBe(
      "https://example.com/path"
    );
    expect(container.querySelectorAll("a")[1]?.textContent).toBe("custom");
    rerender(
      <Markdown content="See https://example.com/path" role="user" reply />
    );
    expect(container.querySelector("a")).toBeNull();
    rerender(
      <Markdown content="See https://example.com/path" role="assistant" />
    );
    expect(container.querySelector("a")).toBeNull();
  });
  it("routes clicks and middle clicks through the desktop external helper", () => {
    const openExternal = vi.fn();
    const { container } = render(
      <MarkdownLinksProvider value={{ openExternal, openFile: vi.fn() }}>
        <Markdown content="https://example.com/" role="assistant" reply />
      </MarkdownLinksProvider>
    );
    const link = container.querySelector("a")!;
    fireEvent.click(link, { metaKey: true });
    fireEvent(
      link,
      new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true })
    );
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(link.rel).toBe("noopener noreferrer");
  });
});
describe("selection", () => {
  it("scopes select all to rendered message text and copies without code chrome", () => {
    const { container } = render(
      <>
        <span>Outside</span>
        <Markdown
          content={"Paragraph.\n\n```js\nlet x = 1;\n```\n\n- One\n- Two"}
          role="user"
          selectable
        />
      </>
    );
    const text = container.querySelector<HTMLElement>("[data-message-text]")!;
    text.focus();
    fireEvent.keyDown(text, { key: "a", ctrlKey: true });
    const selection = document.getSelection()!;
    const copied = selectedText(selection.getRangeAt(0).cloneContents());
    expect(copied).toContain("Paragraph.\n");
    expect(copied).toContain("let x = 1;");
    expect(copied).toContain("- One");
    expect(copied).not.toContain("Copy");
    expect(copied).not.toContain("Outside");
  });
});

it("keeps a selected streaming paragraph stable until selection is released", () => {
  const { container, rerender } = render(
    <Markdown content="First paragraph" role="assistant" selectable streaming />
  );
  const root = container.querySelector<HTMLElement>("[data-message-text]")!;
  root.focus();
  fireEvent.keyDown(root, { key: "a", metaKey: true });
  fireEvent(document, new Event("selectionchange"));
  rerender(
    <Markdown
      content="First paragraph and another token"
      role="assistant"
      selectable
      streaming
    />
  );
  expect(root.textContent).toBe("First paragraph");
  document.getSelection()!.removeAllRanges();
  fireEvent(document, new Event("selectionchange"));
  expect(root.textContent).toBe("First paragraph and another token");
});
