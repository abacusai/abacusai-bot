/**
 * R2-T17 (spec 02 §7): headings, lists, tables in a scroll wrapper, code
 * blocks with a header and Copy, links routed by target (§7.5 table), raw
 * HTML escaped, `javascript:` rendered as text, an unclosed fence without
 * Copy while streaming. R2-T18: reference links and footnotes far from
 * their use render in one long streaming message.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { i18n, initI18n } from "#renderer/lib/i18n";

import { FoldsWholeContext, Markdown, MarkdownLinksProvider } from "./markdown";
import { loadMath } from "./math";
import { fileTarget, prepass } from "./prepass";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en-US");
});

const renderMd = (
  content: string,
  options: { streaming?: boolean; root?: string | null } = {}
) => {
  const links = { openFile: vi.fn(), openExternal: vi.fn() };
  const view = render(
    <MarkdownLinksProvider value={links}>
      <Markdown
        content={content}
        role="assistant"
        streaming={options.streaming ?? false}
        workspaceRoot={options.root ?? "/repo"}
      />
    </MarkdownLinksProvider>
  );
  return { ...view, links };
};

describe("R2-T17 markdown", () => {
  it.each([
    ["a reply", "assistant", false, 1],
    [
      "a user's text outside a bubble (a PR description, a channel)",
      "user",
      false,
      1,
    ],
    ["a user's message folding as a whole in its bubble", "user", true, 0],
  ] as const)(
    "a long code block folds by itself in %s",
    (_label, role, whole, folds) => {
      const code = `\`\`\`text\n${Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n")}\n\`\`\``;
      const { container } = render(
        <FoldsWholeContext value={whole}>
          <Markdown content={code} role={role} workspaceRoot="/repo" />
        </FoldsWholeContext>
      );
      expect(container.querySelectorAll(".chat-code-more")).toHaveLength(folds);
      expect(container.querySelectorAll(".chat-code-collapsed")).toHaveLength(
        folds
      );
    }
  );

  it("escapes code immediately and adds grammar tokens when syntax loads", async () => {
    const { container } = renderMd('```ts\nconst value = "<script>&";\n```');
    const code = container.querySelector("pre code");
    expect(code?.textContent).toContain('const value = "<script>&";');
    expect(code?.querySelector("script")).toBeNull();
    expect(code?.querySelector("span")).toBeNull();
    await waitFor(() => expect(code?.querySelector("span")).toBeTruthy());
    expect(code?.textContent).toContain('const value = "<script>&";');
    expect(code?.querySelector("script")).toBeNull();
  });

  // First in the file: temml is not loaded yet.
  it("math rendered before temml loads updates once it has", async () => {
    const { container } = renderMd("inline $x^2$ and\n\n$$y$$");
    expect(container.querySelector(".chat-math-pending")).toBeTruthy();
    expect(container.querySelector("math")).toBeNull();
    await act(async () => {
      await loadMath();
    });
    expect(container.querySelector(".chat-math-inline math")).toBeTruthy();
    expect(container.querySelector(".chat-math math")).toBeTruthy();
    expect(container.querySelector(".chat-math-pending")).toBeNull();
  });

  it("renders blocks, tables in a scroller and code with chrome", () => {
    const { container } = renderMd(
      "# Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst a = 1;\n```"
    );
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector(".chat-table table")).toBeTruthy();
    const scroller = container.querySelector(
      ".chat-table > .chat-table-scroll"
    );
    expect(scroller?.classList.contains("scroll-fade-x")).toBe(true);
    expect(scroller?.querySelector(":scope > table thead th")).toBeTruthy();
    expect(container.querySelector(".chat-code-lang")?.textContent).toBe("ts");
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
    const code = container.querySelector("pre")!;
    code.focus();
    expect(document.activeElement).toBe(code);
  });

  it("table keeps alignment, inline code and a stable structure while streaming", () => {
    const md =
      "| name | n |\n|:--|--:|\n| `a.scss` | **1** |\n| x | [l](https://e.com) |";
    const { container } = renderMd(md);
    const cells = container.querySelectorAll("tbody tr:first-child td");
    expect((cells[1] as HTMLElement | undefined)?.style.textAlign).toBe(
      "right"
    );
    expect(cells[0]?.querySelector("code")?.textContent).toBe("a.scss");
    expect(container.querySelectorAll(".chat-table")).toHaveLength(1);
    const partial = renderMd("| name | n |\n|:--|--:|\n| `a.sc", {
      streaming: true,
    });
    expect(partial.container.querySelectorAll(".chat-table")).toHaveLength(1);
  });

  it("an unclosed fence renders as a block without Copy while streaming", () => {
    const { container } = renderMd("text\n\n```js\nconst a", {
      streaming: true,
    });
    expect(container.querySelector("pre")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
  });

  it("escapes raw HTML and drops javascript: links", () => {
    const { container } = renderMd(
      '<script>alert(1)</script> [x](javascript:alert(1)) <img src=x onerror="y">'
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img[onerror]")).toBeNull();
    const anchor = [...container.querySelectorAll("a")].find(
      (a) => a.textContent === "x"
    );
    expect(anchor?.getAttribute("href") ?? "").not.toMatch(/javascript/);
  });

  it("routes links: http external, absolute and relative paths to files", () => {
    const { links } = renderMd(
      "[site](https://example.com) [abs](/etc/hosts) [rel](src/a.ts) [enc](file:///Users/me/My%20Docs/a.md)"
    );
    fireEvent.click(screen.getByText("site"));
    expect(links.openExternal).toHaveBeenCalledWith("https://example.com");
    fireEvent.click(screen.getByText("abs"));
    expect(links.openFile).toHaveBeenLastCalledWith("/etc/hosts");
    fireEvent.click(screen.getByText("rel"));
    expect(links.openFile).toHaveBeenLastCalledWith("/repo/src/a.ts");
    fireEvent.click(screen.getByText("enc"));
    expect(links.openFile).toHaveBeenLastCalledWith("/Users/me/My Docs/a.md");
  });

  it("no link navigates the window (hash router); anchors scroll in place", () => {
    const before = window.location.href;
    const scrolled = vi.fn();
    const { container, links } = renderMd(
      "A note[^1] and [section](#part) and [bare](a.ts).\n\n[^1]: The footnote.",
      { root: null }
    );
    for (const target of container.querySelectorAll("[id]"))
      (target as HTMLElement).scrollIntoView = scrolled;
    for (const anchor of container.querySelectorAll("a")) {
      const event = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      anchor.dispatchEvent(event);
      expect(event.defaultPrevented, anchor.getAttribute("href") ?? "").toBe(
        true
      );
    }
    expect(window.location.href).toBe(before);
    expect(scrolled).toHaveBeenCalled();
    // A scheme-less relative target is a workspace file (§7.5).
    expect(links.openFile).toHaveBeenCalledWith("/repo/a.ts");
    expect(links.openExternal).not.toHaveBeenCalled();
  });

  it("reference definitions naming files open them", () => {
    const { links } = renderMd("See [the file][f].\n\n[f]: /abs/My%20File.md");
    fireEvent.click(screen.getByText("the file"));
    expect(links.openFile).toHaveBeenCalledWith("/abs/My File.md");
  });

  it("display math stays inside a quote and a list item", async () => {
    await loadMath();
    const { container } = renderMd("> $$x$$\n\n- item\n\n  $$\n  y\n  $$");
    expect(container.querySelector("blockquote .chat-math")).toBeTruthy();
    expect(container.querySelector("li .chat-math")).toBeTruthy();
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
    expect(prepass("`[a](/x)` and [b](/y)", { workspaceRoot: null })).toBe(
      "`[a](/x)` and [b](#abacus-file=%2Fy)"
    );
  });
});

describe("R2-T18 whole-document rendering", () => {
  it("resolves far references and footnotes while streaming", () => {
    const filler = Array.from(
      { length: 60 },
      (_, index) => `Paragraph ${index} with some text.`
    ).join("\n\n");
    const { container } = renderMd(
      `See [the docs][docs] and a note[^1].\n\n${filler}\n\n[docs]: https://example.com/docs\n\n[^1]: The footnote.`,
      { streaming: true }
    );
    const docs = [...container.querySelectorAll("a")].find(
      (a) => a.textContent === "the docs"
    );
    expect(docs?.getAttribute("href")).toBe("https://example.com/docs");
    expect(container.textContent).toContain("The footnote.");
  });
});

describe("visualizer blocks", () => {
  const widget =
    "```visualizer\n<svg><text>a < b</text></svg><script>1</script>\n```";

  it("renders a script-only sandboxed iframe with the source in srcdoc", () => {
    const { container } = renderMd(widget);
    const frame = container.querySelector("iframe");
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("sandbox")).toBe("allow-scripts");
    const doc = frame!.getAttribute("srcdoc") ?? "";
    expect(doc).toContain("<svg><text>a < b</text></svg>");
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("connect-src 'none'");
    expect(container.querySelector("pre")).toBeNull();
  });

  it("draws a placeholder, not the frame, while streaming", () => {
    const { container } = renderMd(widget, { streaming: true });
    expect(container.querySelector("iframe")).toBeNull();
  });
});

describe("untrusted text", () => {
  const renderUntrusted = (content: string) => {
    const links = { openFile: vi.fn(), openExternal: vi.fn() };
    const view = render(
      <MarkdownLinksProvider value={links}>
        <Markdown content={content} role="user" untrusted />
      </MarkdownLinksProvider>
    );
    return { ...view, links };
  };

  it("shows a visualizer fence as code, never a frame", () => {
    const { container } = renderUntrusted(
      "```visualizer\n<script>parent.postMessage({type:'link'})</script>\n```"
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("pre code")?.textContent).toContain(
      "<script>parent.postMessage"
    );
  });

  it("leaves math as text and code", () => {
    const { container } = renderUntrusted(
      "cost $x$ and\n\n```math\ny\n```\n\n`\u2062z`"
    );
    expect(container.querySelector(".chat-math")).toBeNull();
    expect(container.querySelector(".chat-math-inline")).toBeNull();
    expect(container.textContent).toContain("$x$");
  });

  it("opens only http(s) and mailto links, and no files", () => {
    const { container, links } = renderUntrusted(
      "[web](https://example.com) [mail](mailto:a@b.c) [file](#abacus-file=%2Fetc%2Fpasswd) [rel](docs/x.md)"
    );
    const anchor = (text: string) =>
      [...container.querySelectorAll("a")].find((a) => a.textContent === text)!;
    fireEvent.click(anchor("web"));
    fireEvent.click(anchor("mail"));
    fireEvent.click(anchor("file"));
    fireEvent.click(anchor("rel"));
    expect(links.openExternal.mock.calls).toEqual([
      ["https://example.com"],
      ["mailto:a@b.c"],
    ]);
    expect(links.openFile).not.toHaveBeenCalled();
    expect(anchor("file").hasAttribute("href")).toBe(false);
    expect(anchor("rel").hasAttribute("href")).toBe(false);
  });
});

describe("prose filenames", () => {
  it("link to a session artifact registered for the thread", async () => {
    const { setKnownFiles } = await import("./known-files");
    const { ChatViewProvider } = await import("../kit/context");
    setKnownFiles("t1", new Map([["report.pdf", "/repo/report.pdf"]]));
    const links = { openFile: vi.fn(), openExternal: vi.fn() };
    render(
      <ChatViewProvider value={{ threadId: "t1" } as never}>
        <MarkdownLinksProvider value={links}>
          <Markdown content="Wrote report.pdf." role="assistant" />
        </MarkdownLinksProvider>
      </ChatViewProvider>
    );
    fireEvent.click(screen.getByRole("link", { name: "report.pdf" }));
    expect(links.openFile).toHaveBeenCalledWith("/repo/report.pdf");
    setKnownFiles("t1", new Map());
  });
});
