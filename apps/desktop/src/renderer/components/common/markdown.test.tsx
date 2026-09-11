import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("./visualizer-segment", () => ({
  VisualizerSegment: ({ code }: { code: string }) => <div>{code}</div>,
}));
vi.mock("../../providers/preview-link-context", () => ({
  usePreviewLinkHandler: () => null,
}));
vi.mock("../../stores/app-global", () => ({
  useGlobalContext: (selector: (state: { homeDir: string }) => unknown) =>
    selector({ homeDir: "/home/test" }),
}));
vi.mock("../../stores/code-folder-context", () => ({
  useCodeFolderContext: (
    selector: (state: { currentFolder: string }) => unknown
  ) => selector({ currentFolder: "/workspace" }),
}));

const { Markdown } = await import("./markdown");

describe("Markdown", () => {
  it("renders lists with explicit marker indentation", () => {
    const { container } = render(
      <Markdown content={"- first\n- second\n\n1. third"} />
    );

    expect(container.querySelector("ul")?.className).toContain("pl-5");
    expect(container.querySelector("ul")?.className).toContain("list-disc");
    expect(container.querySelector("ol")?.className).toContain("list-decimal");
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("uses TanStack Highlight for fenced code", () => {
    const { container } = render(
      <Markdown content={"```ts\nconst answer = 42\n```"} />
    );

    expect(container.querySelector("pre.th-code")).not.toBeNull();
    expect(container.querySelector(".th-keyword")?.textContent).toBe("const");
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Copy code"
    );
  });

  it("does not preprocess links or math inside code", () => {
    const source = "[file](file:///tmp/a.ts) $not_math$";
    const { container } = render(
      <Markdown content={`\`\`\`md\n${source}\n\`\`\``} />
    );

    expect(container.querySelector("pre")?.textContent).toContain(source);
    expect(container.querySelector(".katex")).toBeNull();
  });

  it("keeps tables inside an overflow container", () => {
    const { container } = render(
      <Markdown content={"| Name | Value |\n| --- | --- |\n| one | two |"} />
    );

    const table = container.querySelector("table");
    expect(table?.parentElement?.className).toContain("overflow-x-auto");
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelectorAll("td")).toHaveLength(2);
  });

  it("renders math without enabling raw HTML", () => {
    const { container } = render(
      <Markdown
        content={
          "Inline $x^2$\n\n$$\\frac{1}{2}$$\n\n<script>alert(1)</script>"
        }
      />
    );

    expect(container.querySelector(".katex-inline .katex")).not.toBeNull();
    expect(container.querySelector(".katex-display")).not.toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("linkifies literal web URLs but drops executable links", () => {
    const { container } = render(
      <Markdown
        content={
          "Read https://tanstack.com/markdown. [unsafe](javascript:alert(1))"
        }
      />
    );

    const links = Array.from(container.querySelectorAll("a"));
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://tanstack.com/markdown");
    expect(container.textContent).toContain("unsafe");
  });

  it("keeps data images after the safe URL parse", () => {
    const source = "data:image/png;base64,iVBORw0KGgo=";
    const { container } = render(<Markdown content={`![chart](${source})`} />);

    expect(container.querySelector("img")?.getAttribute("src")).toBe(source);
  });
});
