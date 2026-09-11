/**
 * The Artifacts page: what a row shows, and where a click takes you.
 *
 * Clicking an artifact used to land on `/` — whatever chat was active — with
 * the pane closed by the route on arrival, so the user saw a session and no
 * file. It goes to the artifact's own conversation now and opens there. The
 * location was a column that disappeared below a wide breakpoint; it is now
 * always on the row, selectable, with its own copy button.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionArtifact } from "#shared/contracts";
import { sessionConversationKey } from "#shared/conversation-scope";

const activate = vi.hoisted(() => vi.fn(() => true));
const openAbsoluteFileInPreview = vi.hoisted(() => vi.fn());
const openUrlInPreview = vi.hoisted(() => vi.fn());
const artifacts = vi.hoisted(() => ({ current: [] as SessionArtifact[] }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.count != null ? `${key}:${String(values.count)}` : key,
  }),
}));

vi.mock("./workspace-activation", () => ({
  useConversationActivator: () => activate,
}));

vi.mock("../../conversation/persistence", () => ({
  prefetchTranscript: vi.fn(),
}));

vi.mock("../../hooks/use-workspace-queries", () => ({
  useSessionArtifactsQuery: () => ({
    data: artifacts.current,
    refetch: vi.fn(),
    isFetching: false,
  }),
  useAllAgentSessionsQuery: () => ({
    data: [
      {
        id: "session-a",
        workspaceId: "workspace-1",
        label: "Migration chat",
        updatedAt: "2026-09-07T00:00:00.000Z",
        createdAt: "2026-09-07T00:00:00.000Z",
      },
    ],
  }),
}));

vi.mock("../../utils/preview-utils", () => ({
  openAbsoluteFileInPreview,
  openUrlInPreview,
}));

const { ArtifactsPanel } = await import("./artifacts-panel");
const { getActiveConversationKey, setActiveConversationKey } =
  await import("../../stores/active-conversation-store");

const artifact = (over: Partial<SessionArtifact> = {}): SessionArtifact => ({
  id: "session-a::/Users/me/out/report.md",
  workspaceId: "workspace-1",
  sessionId: "session-a",
  kind: "file",
  title: "report.md",
  location: "/Users/me/out/report.md",
  toolName: "write",
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
  ...over,
});

const byId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-id="${id}"]`);

const renderPanel = (): void => {
  render((<ArtifactsPanel />) as JSX.Element);
};

beforeEach(() => {
  activate.mockClear();
  openAbsoluteFileInPreview.mockClear();
  openUrlInPreview.mockClear();
  artifacts.current = [artifact()];
  setActiveConversationKey(null);
  Object.assign(window, {
    api: {
      files: {
        readFileAsText: vi.fn(async () => ({ success: true, content: "#" })),
      },
      showItemInFolder: vi.fn(),
    },
  });
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => undefined) },
  });
});

describe("opening an artifact", () => {
  it("goes to the artifact's own conversation and opens the file in that pane", async () => {
    renderPanel();

    fireEvent.click(byId("artifact-open-session-a::/Users/me/out/report.md")!);

    await waitFor(() => {
      expect(openAbsoluteFileInPreview).toHaveBeenCalled();
    });
    expect(activate).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      sessionId: "session-a",
    });
    const scope = sessionConversationKey("workspace-1", "session-a");
    expect(openAbsoluteFileInPreview).toHaveBeenCalledWith(
      "/Users/me/out/report.md",
      undefined,
      { scope }
    );
    // The open counts as "on screen" right away rather than after the shell's
    // next render, so the pane comes forward instead of earning a dot.
    expect(getActiveConversationKey()).toBe(scope);
  });

  it("opens a link as a browser tab in its own conversation", () => {
    artifacts.current = [
      artifact({
        id: "session-a::http://localhost:5173",
        kind: "link",
        title: "localhost:5173",
        location: "http://localhost:5173",
      }),
    ];
    renderPanel();

    fireEvent.click(byId("artifact-open-session-a::http://localhost:5173")!);

    expect(openUrlInPreview).toHaveBeenCalledWith("http://localhost:5173", {
      scope: sessionConversationKey("workspace-1", "session-a"),
    });
    expect(activate).toHaveBeenCalledOnce();
  });

  it("still opens just the chat from the session column", () => {
    renderPanel();

    fireEvent.click(
      byId("artifact-session-session-a::/Users/me/out/report.md")!
    );

    expect(activate).toHaveBeenCalledOnce();
    expect(openAbsoluteFileInPreview).not.toHaveBeenCalled();
  });
});

describe("the location on a row", () => {
  it("is the file's name on the row, and the whole path on the copy button", () => {
    renderPanel();

    // The path used to take the middle of the row in four wrapped lines of
    // monospace. What identifies the artifact is its name; the rest is one
    // profile directory, the same on every row.
    // One "report.md": this artifact's title is its file name, and saying it
    // twice is what the row used to do with the path.
    expect(screen.getAllByText("report.md")).toHaveLength(1);
    expect(screen.queryByText("/Users/me/out/report.md")).toBeNull();
    expect(
      document
        .querySelector(
          '[data-id="artifact-copy-session-a::/Users/me/out/report.md"]'
        )
        ?.getAttribute("title")
    ).toBe("/Users/me/out/report.md");
  });

  it("copies the path", async () => {
    renderPanel();

    fireEvent.click(
      document.querySelector<HTMLElement>(
        '[data-id="artifact-copy-session-a::/Users/me/out/report.md"]'
      )!
    );

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "/Users/me/out/report.md"
      );
    });
  });

  it("reveals a file in the file manager, and offers no folder for a link", () => {
    artifacts.current = [
      artifact(),
      artifact({
        id: "session-a::http://localhost:5173",
        kind: "link",
        title: "localhost:5173",
        location: "http://localhost:5173",
      }),
    ];
    renderPanel();

    fireEvent.click(
      document.querySelector<HTMLElement>(
        '[data-id="artifact-reveal-session-a::/Users/me/out/report.md"]'
      )!
    );
    expect(window.api.showItemInFolder).toHaveBeenCalledWith(
      "/Users/me/out/report.md"
    );
    expect(
      document.querySelector(
        '[data-id="artifact-reveal-session-a::http://localhost:5173"]'
      )
    ).toBeNull();
    expect(
      document.querySelector(
        '[data-id="artifact-copy-session-a::http://localhost:5173"]'
      )
    ).not.toBeNull();
  });
});
