/**
 * R3-T33 (components half): relative paths resolve against the workspace
 * root, absolute ones stay; guest `/workspace/…` reads are contained by the
 * workspace root; the preview renders each viewable kind and hands office
 * documents to the OS; the card's rows and secondary actions. The routing
 * and the `preview-open` bridge are `features/bots/chat/preview.test.tsx`.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { i18n, initI18n } from "#renderer/lib/i18n";

import { DeliverablesCard } from "./deliverables-card";
import { FilePreview } from "./file-preview";
import {
  containmentRootFor,
  hasInAppViewer,
  previewKind,
  resolveWorkspacePath,
} from "./paths";

beforeAll(async () => {
  await initI18n();
  await i18n.changeLanguage("en-US");
});

describe("paths", () => {
  it("resolves relative paths against the workspace, keeps absolute ones", () => {
    expect(resolveWorkspacePath("out/a.md", "/w/")).toBe("/w/out/a.md");
    expect(resolveWorkspacePath("./a.md", "/w")).toBe("/w/a.md");
    expect(resolveWorkspacePath("/x/a.md", "/w")).toBe("/x/a.md");
    expect(resolveWorkspacePath("C:\\x\\a.md", "/w")).toBe("C:\\x\\a.md");
    expect(resolveWorkspacePath("a.md", null)).toBe("a.md");
  });

  it("contains guest /workspace reads by the workspace root", () => {
    expect(containmentRootFor("/workspace/a.md", "/host/w")).toBe("/host/w");
    expect(containmentRootFor("/x/y/a.md", "/host/w")).toBe("/x/y");
    expect(containmentRootFor("a.md", "/host/w")).toBe("/host/w");
  });

  it("knows which types have an in-app viewer", () => {
    expect(previewKind("/a.png")).toBe("image");
    expect(previewKind("/a.md")).toBe("markdown");
    expect(previewKind("/a.ts")).toBe("code");
    expect(previewKind("/a.txt")).toBe("text");
    expect(previewKind("/a.pptx")).toBe("pptx");
    expect(previewKind("/a.docx")).toBe("external");
    expect(previewKind("/a.zip")).toBe("external");
    expect(hasInAppViewer("/a.docx")).toBe(false);
    expect(hasInAppViewer("/a.pdf")).toBe(true);
  });
});

describe("FilePreview", () => {
  const reads = () => ({
    text: vi.fn(async () => ({ content: "# Title\n\nbody", truncated: false })),
    image: vi.fn(async () => "data:image/png;base64,AAAA"),
    pptx: vi.fn(async () => ({
      deck: {
        widthEmu: 9144000,
        heightEmu: 5143500,
        warnings: [],
        slides: [
          {
            number: 1,
            templateShapes: [],
            background: { type: "solid", color: "#123456" },
            shapes: [
              {
                kind: "image",
                id: "image",
                xEmu: 914400,
                yEmu: 914400,
                widthEmu: 1828800,
                heightEmu: 914400,
                dataUrl: "data:image/png;base64,AAAA",
                geometry: "rect",
                line: null,
              },
            ],
            notes: null,
          },
        ],
      },
    })),
    localUrl: vi.fn(async () => "file:///host/w/report.pdf"),
  });

  it("reads text with the containment root and renders markdown", async () => {
    const read = reads();
    render(
      <FilePreview
        path="/w/a.md"
        hostRoot="/w"
        read={read}
        onOpenExternally={() => {}}
      />
    );
    await screen.findByText("Title");
    expect(read.text).toHaveBeenCalledWith("/w/a.md", "/w");
  });

  it("renders code as text and images from a data URL", async () => {
    const read = reads();
    const { unmount } = render(
      <FilePreview
        path="/w/a.ts"
        hostRoot="/w"
        read={read}
        onOpenExternally={() => {}}
      />
    );
    await screen.findByText(/body/);
    unmount();
    render(
      <FilePreview
        path="/w/a.png"
        hostRoot="/w"
        read={read}
        onOpenExternally={() => {}}
      />
    );
    expect((await screen.findByRole("img")).getAttribute("src")).toBe(
      "data:image/png;base64,AAAA"
    );
  });

  it("renders authored slide backgrounds and image geometry", async () => {
    render(
      <FilePreview
        path="/w/d.pptx"
        hostRoot="/w"
        read={reads()}
        onOpenExternally={() => {}}
      />
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="file-preview-slides"] img')
      ).toBeTruthy()
    );
    const img = document.querySelector<HTMLImageElement>(
      '[data-slot="file-preview-slides"] img'
    )!;
    expect(img.style.left).toBe("96px");
    expect(img.style.width).toBe("192px");
    expect(img.parentElement?.style.background).toBe("rgb(18, 52, 86)");
  });
  it.each(["pdf", "html"])(
    "resolves guest %s through the host boundary before loading",
    async (extension) => {
      const read = reads();
      const { container } = render(
        <FilePreview
          path={`/workspace/report.${extension}`}
          hostRoot="/host/w"
          read={read}
          onOpenExternally={() => {}}
        />
      );
      await waitFor(() =>
        expect(container.querySelector("webview")?.getAttribute("src")).toBe(
          "file:///host/w/report.pdf"
        )
      );
      expect(read.localUrl).toHaveBeenCalledWith(
        `/workspace/report.${extension}`,
        "/host/w"
      );
    }
  );

  it("rejects a non-file URL returned by the local host resolver", async () => {
    const read = reads();
    read.localUrl.mockResolvedValue("https://example.com/report.pdf");
    const { container } = render(
      <FilePreview
        path="/workspace/report.pdf"
        hostRoot="/host/w"
        read={read}
        onOpenExternally={() => {}}
      />
    );
    await screen.findByRole("status");
    expect(container.querySelector("webview")).toBeNull();
  });

  it("offers the OS app for office documents without reading them", () => {
    const read = reads();
    const external = vi.fn();
    render(
      <FilePreview
        path="/w/a.docx"
        hostRoot="/w"
        read={read}
        onOpenExternally={external}
      />
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Open with default app" })[1]!
    );
    expect(external).toHaveBeenCalledWith("/w/a.docx");
    expect(read.text).not.toHaveBeenCalled();
  });
});

describe("DeliverablesCard", () => {
  const items = [
    { path: "/w/a.md", isUrl: false },
    { path: "https://x.dev", label: "App", isUrl: true },
    { path: "/w/b.pdf", isUrl: false },
    { path: "/w/c.png", isUrl: false },
  ];

  it("shows three rows then Show all", () => {
    render(
      <DeliverablesCard
        items={items}
        onOpen={() => {}}
        onReveal={() => {}}
        onOpenUrl={() => {}}
      />
    );
    expect(screen.queryByText("c.png")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show all/ }));
    expect(screen.getByText("c.png")).toBeTruthy();
  });

  it("reveals files and opens URLs from the secondary button", () => {
    const reveal = vi.fn();
    const url = vi.fn();
    const open = vi.fn();
    render(
      <DeliverablesCard
        items={items}
        onOpen={open}
        onReveal={reveal}
        onOpenUrl={url}
      />
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Show in folder" })[0]!
    );
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
    fireEvent.click(screen.getByText("App"));
    expect(reveal).toHaveBeenCalledWith(items[0]);
    expect(url).toHaveBeenCalledWith(items[1]);
    expect(open).toHaveBeenCalledWith(items[1]);
  });
});
