/**
 * The files card: a click opens the file where it can be shown, the folder
 * button finds it on disk, and nothing opens on its own.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TurnDeliverable } from "./deliverables";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count != null ? `${key}:${options.count}` : key,
  }),
}));

vi.mock("../../hooks/use-workspace-root", () => ({
  useResolveWorkspacePath: () => (path: string) =>
    path.startsWith("/") ? path : `/workspace/${path}`,
  useWorkspaceRoot: () => "/workspace",
}));

const openFile = vi.fn();
const openUrl = vi.fn();
vi.mock("../../utils/preview-utils", () => ({
  containmentRootFor: (_path: string, root: string | null) => root ?? "",
  openAbsoluteFileInPreview: (path: string, root: string) =>
    openFile(path, root),
  openUrlInPreview: (url: string) => openUrl(url),
}));

const { DeliverablesPill } = await import("./deliverables-pill");

const showItemInFolder = vi.fn();
const openExternal = vi.fn();

beforeEach(() => {
  Object.defineProperty(window, "api", {
    configurable: true,
    value: { showItemInFolder, openExternal },
  });
});

const file = (path: string, label?: string): TurnDeliverable => ({
  path,
  ...(label != null ? { label } : {}),
  isUrl: false,
});

describe("DeliverablesPill", () => {
  it("names each file, preferring the agent's label", () => {
    render(
      (
        <DeliverablesPill
          items={[file("/w/report.docx", "Q3 report"), file("out/deck.pdf")]}
        />
      ) as JSX.Element
    );

    expect(screen.getByText("Q3 report")).not.toBeNull();
    expect(screen.getByText("deck.pdf")).not.toBeNull();
    expect(screen.getByText("2")).not.toBeNull();
  });

  it("opens a file from the row and finds it from the folder button", () => {
    render(
      (<DeliverablesPill items={[file("out/deck.pdf")]} />) as JSX.Element
    );

    fireEvent.click(screen.getByText("deck.pdf"));
    expect(openFile).toHaveBeenCalledWith(
      "/workspace/out/deck.pdf",
      "/workspace"
    );

    fireEvent.click(screen.getByLabelText("deliverables.showInFolder"));
    expect(showItemInFolder).toHaveBeenCalledWith("/workspace/out/deck.pdf");
  });

  it("sends a served app to the preview, and to the browser on request", () => {
    render(
      (
        <DeliverablesPill
          items={[{ path: "http://localhost:5173", isUrl: true }]}
        />
      ) as JSX.Element
    );

    fireEvent.click(screen.getByText("http://localhost:5173"));
    expect(openUrl).toHaveBeenCalledWith("http://localhost:5173");

    fireEvent.click(screen.getByLabelText("deliverables.openInBrowser"));
    expect(openExternal).toHaveBeenCalledWith("http://localhost:5173");
  });

  it("folds a long list behind a count", () => {
    const items = Array.from({ length: 8 }, (_, i) => file(`/w/part-${i}.pdf`));
    render((<DeliverablesPill items={items} />) as JSX.Element);

    expect(screen.queryByText("part-7.pdf")).toBeNull();
    fireEvent.click(screen.getByText("deliverables.showMore:2"));
    expect(screen.getByText("part-7.pdf")).not.toBeNull();
  });
});
