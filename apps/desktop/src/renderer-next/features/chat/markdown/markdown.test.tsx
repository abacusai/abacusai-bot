/**
 * R2-T17 (spec 02 §7): headings, lists, tables in a scroll wrapper, code
 * blocks with a header and Copy, links routed by target (§7.5 table), raw
 * HTML escaped, `javascript:` rendered as text, an unclosed fence without
 * Copy while streaming. R2-T18: reference links and footnotes far from
 * their use render in one long streaming message.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { i18n, initI18n } from "#next/lib/i18n";

import { Markdown, MarkdownLinksProvider } from "./markdown";
import { fileTarget, prepass } from "./prepass";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en-US");
});

const renderMd = (content: string, options: { streaming?: boolean; root?: string | null } = {}) => {
  const links = { openFile: vi.fn(), openExternal: vi.fn() };
  const view = render(
    <MarkdownLinksProvider value={links}>
      <Markdown content={content} role="assistant" streaming={options.streaming ?? false} workspaceRoot={options.root ?? "/repo"} />
    </MarkdownLinksProvider>
  );
  return { ...view, links };
};

describe("R2-T17 markdown", () => {
  it("renders blocks, tables in a scroller and code with chrome", () => {
    const { container } = renderMd("# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst a = 1;\n```");
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector(".chat-table table")).toBeTruthy();
    expect(container.querySelector(".chat-code-lang")?.textContent).toBe("ts");
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
  });

  it("an unclosed fence renders as a block without Copy while streaming", () => {
    const { container } = renderMd("text\n\n```js\nconst a", { streaming: true });
    expect(container.querySelector("pre")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
  });

  it("escapes raw HTML and drops javascript: links", () => {
    const { container } = renderMd('<script>alert(1)</script> [x](javascript:alert(1)) <img src=x onerror="y">');
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector('img[onerror]')).toBeNull();
    const anchor = [...container.querySelectorAll("a")].find((a) => a.textContent === "x");
    expect(anchor?.getAttribute("href") ?? "").not.toMatch(/javascript/);
  });

  it("routes links: http external, absolute and relative paths to files", () => {
    const { links } = renderMd("[site](https://example.com) [abs](/etc/hosts) [rel](src/a.ts) [enc](file:///Users/me/My%20Docs/a.md)");
    fireEvent.click(screen.getByText("site"));
    expect(links.openExternal).toHaveBeenCalledWith("https://example.com");
    fireEvent.click(screen.getByText("abs"));
    expect(links.openFile).toHaveBeenLastCalledWith("/etc/hosts");
    fireEvent.click(screen.getByText("rel"));
    expect(links.openFile).toHaveBeenLastCalledWith("/repo/src/a.ts");
    fireEvent.click(screen.getByText("enc"));
    expect(links.openFile).toHaveBeenLastCalledWith("/Users/me/My Docs/a.md");
  });

  it("the §7.5 table", () => {
    expect(fileTarget("file:///C:/x/y.ts", null)).toBe("C:/x/y.ts");
    expect(fileTarget("C:\\x\\y.ts", null)).toBe("C:\\x\\y.ts");
    expect(fileTarget("./a.ts", "/repo")).toBe("/repo/a.ts");
    expect(fileTarget("../b.ts", "/repo/sub")).toBe("/repo/b.ts");
    expect(fileTarget("a.ts", null)).toBeNull();
    expect(fileTarget("https://x", "/repo")).toBeNull();
    expect(fileTarget("mailto:a@b", "/repo")).toBeNull();
    expect(fileTarget("#x", "/repo")).toBeNull();
    expect(prepass("`[a](/x)` and [b](/y)", { workspaceRoot: null })).toBe("`[a](/x)` and [b](#abacus-file=%2Fy)");
  });
});

describe("R2-T18 whole-document rendering", () => {
  it("resolves far references and footnotes while streaming", () => {
    const filler = Array.from({ length: 60 }, (_, index) => `Paragraph ${index} with some text.`).join("\n\n");
    const { container } = renderMd(`See [the docs][docs] and a note[^1].\n\n${filler}\n\n[docs]: https://example.com/docs\n\n[^1]: The footnote.`, { streaming: true });
    const docs = [...container.querySelectorAll("a")].find((a) => a.textContent === "the docs");
    expect(docs?.getAttribute("href")).toBe("https://example.com/docs");
    expect(container.textContent).toContain("The footnote.");
  });
});
