/**
 * Where a link in the agent's prose goes when it is clicked.
 *
 * Two destinations, and the split is what this pins. A web link goes to the
 * browser: the preview pane is a viewer for what the agent made, and it has
 * none of a browser's furniture — no address bar to see where you have landed,
 * no tabs, no history, none of the sessions the user is signed into. A path on
 * disk still opens in the pane, because showing you a file it just wrote is
 * exactly what the pane is for.
 *
 * The pane used to take both, so clicking a citation quietly navigated a
 * chrome-less webview to somebody else's site.
 */
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const previewHandler = vi.fn();
const openExternal = vi.fn();
const openLocalFile = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("./visualizer-segment", () => ({
  VisualizerSegment: ({ code }: { code: string }) => <div>{code}</div>,
}));
vi.mock("../../providers/preview-link-context", () => ({
  usePreviewLinkHandler: () => previewHandler,
}));
vi.mock("../../utils/open-local-file", () => ({ openLocalFile }));
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

const clickLink = (markdown: string): void => {
  vi.clearAllMocks();
  (globalThis.window as unknown as { api: unknown }).api = { openExternal };
  const { container } = render(<Markdown content={markdown} />);
  const anchor = container.querySelector("a");
  if (anchor == null) throw new Error(`no link rendered for: ${markdown}`);
  fireEvent.click(anchor);
};

describe("a web link", () => {
  it("goes to the browser, not the preview pane", () => {
    clickLink("[the report](https://example.com/report)");

    expect(openExternal).toHaveBeenCalledWith("https://example.com/report");
    expect(previewHandler).not.toHaveBeenCalled();
  });

  it("goes there even though a pane is available to take it", () => {
    // The handler is mocked as present throughout: the point is that having
    // somewhere to put the link is no longer a reason to put it there.
    clickLink("[plain](http://example.com/plain)");

    expect(openExternal).toHaveBeenCalledWith("http://example.com/plain");
    expect(previewHandler).not.toHaveBeenCalled();
  });
});

describe("a path on disk", () => {
  it("still opens in the preview pane, which is what it is for", () => {
    clickLink("[the notes](/Users/ada/notes.md)");

    expect(previewHandler).toHaveBeenCalledWith("/Users/ada/notes.md");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("is resolved against the workspace before it is opened", () => {
    clickLink("[src](./src/index.ts)");

    expect(previewHandler).toHaveBeenCalledWith("/workspace/src/index.ts");
    expect(openExternal).not.toHaveBeenCalled();
  });
});
